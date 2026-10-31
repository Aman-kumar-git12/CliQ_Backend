const { prisma } = require("../../../prisma/prismaClient");

const {
    SMART_RECOMMENDATION_BATCH_SIZE,
    SMART_RECOMMENDATION_RESPONSE_SIZE,
    SMART_RECOMMENDATION_CACHE_TTL_SECONDS,
    getProfileQualityScore,
    getProfileQualityLabel,
    getRecommendationCachePayload,
    getCachedRecommendationBatch,
    setCachedRecommendationBatch,
    invalidateRecommendationCache,
    filterUsersForResponse,
    getPersistentExcludedIds,
    getEligibleRecommendationCandidates,
    refreshRecommendationCacheInBackground,
    warmRecommendationCacheForUser,
} = require("../../utils/recommendations");
const logger = require("../../utils/logger");
const { withoutSecrets } = require("../../utils/auth/authUtils");

const getRandomUser = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;

        const connections = await prisma.connectionsRequest.findMany({
            where: {
                OR: [{ toUserId: loggedInUserId }, { fromUserId: loggedInUserId }],
            },
            select: {
                fromUserId: true,
                toUserId: true,
            },
        });

        const excludedUserIds = new Set();
        connections.forEach((conn) => {
            excludedUserIds.add(conn.fromUserId);
            excludedUserIds.add(conn.toUserId);
        });
        excludedUserIds.add(loggedInUserId);

        const excludedArray = Array.from(excludedUserIds);

        const count = await prisma.users.count({
            where: {
                id: { notIn: excludedArray },
            },
        });

        if (count === 0) {
            return res.status(404).json({ message: "No random user available" });
        }

        const skip = Math.floor(Math.random() * count);

        const randomUser = await prisma.users.findMany({
            where: {
                id: { notIn: excludedArray },
            },
            skip: skip,
            take: 1,
        });

        res.json(withoutSecrets(randomUser[0]));
    } catch (err) {
        logger.error(`${req.method} ${req.originalUrl} failed:`, err);
        res.status(500).json({
            message: "Internal Server Error",
        });
    }
};

const weightedSampleUsers = (users = [], limit = SMART_RECOMMENDATION_RESPONSE_SIZE) => {
    const pool = [...users];
    const selected = [];

    while (pool.length > 0 && selected.length < limit) {
        const weights = pool.map((user, index) => {
            const score = Math.max(Number(user?.matchScore || 0), 0.1);
            const rankBias = Math.max(pool.length - index, 1) * 0.015;
            return Math.pow(score, 2) + rankBias;
        });
        const totalWeight = weights.reduce((sum, weight) => sum + weight, 0);

        if (totalWeight <= 0) {
            selected.push(...pool.splice(0, limit - selected.length));
            break;
        }

        let cursor = Math.random() * totalWeight;
        let pickedIndex = 0;

        for (let index = 0; index < pool.length; index += 1) {
            cursor -= weights[index];
            if (cursor <= 0) {
                pickedIndex = index;
                break;
            }
        }

        const [pickedUser] = pool.splice(pickedIndex, 1);
        if (pickedUser) {
            selected.push(pickedUser);
        }
    }

    return selected;
};

const selectRefreshUsers = (
    users = [],
    excludedIds = [],
    { limit = SMART_RECOMMENDATION_RESPONSE_SIZE, windowSize = 12 } = {},
) => {
    const eligibleUsers = filterUsersForResponse(users, excludedIds, users.length);
    if (eligibleUsers.length <= limit) {
        return eligibleUsers.slice(0, limit);
    }

    const refreshWindow = eligibleUsers.slice(0, Math.min(windowSize, eligibleUsers.length));
    return weightedSampleUsers(refreshWindow, limit);
};

const buildSeedRecommendationBatch = (candidates = [], limit = SMART_RECOMMENDATION_BATCH_SIZE) =>
    candidates.slice(0, limit).map((candidate) => {
        const profileQualityScore = getProfileQualityScore(candidate.expertise || {});
        const profileQualityLabel = getProfileQualityLabel(profileQualityScore);

        return {
            ...candidate,
            matchScore: 0.45,
            matchConfidence: "Potential match",
            profileQualityScore,
            profileQualityLabel,
            selectionMode: "seed",
            diversity: null,
            matchReasons: ["Recommended from your current discovery pool"],
            matchReason: "Recommended from your current discovery pool",
            matchWarning: null,
        };
    });

const getSmartUsers = async (req, res) => {
    try {
        const loggedInUserId = req.user?.id;
        if (!loggedInUserId) {
            return res.status(401).json({ message: "UserId missing in request" });
        }

        const { excludeIds = [], refresh = "false" } = req.query;
        const isRefreshRequest = refresh === "true";
        const excludeArray = Array.isArray(excludeIds) ? excludeIds : [excludeIds].filter(Boolean);

        logger.info(`[SmartUsers] Request from ${loggedInUserId}, excludeCount: ${excludeArray.length}`);

        if (isRefreshRequest) {
            await invalidateRecommendationCache(loggedInUserId);
            logger.info(`[SmartUsers] Cache invalidated for user ${loggedInUserId} (refresh requested)`);
        }

        let [persistentExcludedIds, cachedBatch] = await Promise.all([
            getPersistentExcludedIds(loggedInUserId),
            getCachedRecommendationBatch(loggedInUserId),
        ]);
        logger.debug(
            `[SmartUsers] Exclusions: ${persistentExcludedIds.length}, Cache: ${cachedBatch?.users?.length || 0}`,
        );

        if (!cachedBatch || !cachedBatch.users || cachedBatch.users.length === 0 || isRefreshRequest) {
            logger.info(`[SmartUsers] Cache miss for ${loggedInUserId}. Preparing fast seed batch...`);

            const seedCandidates = await getEligibleRecommendationCandidates(loggedInUserId, persistentExcludedIds, {
                take: Math.max(SMART_RECOMMENDATION_BATCH_SIZE * 2, 24),
            });
            const seedUsers = buildSeedRecommendationBatch(seedCandidates, SMART_RECOMMENDATION_BATCH_SIZE);

            if (seedUsers.length > 0) {
                cachedBatch = getRecommendationCachePayload(seedUsers, "seed");
                await setCachedRecommendationBatch(
                    loggedInUserId,
                    cachedBatch,
                    Math.max(30, Math.floor(SMART_RECOMMENDATION_CACHE_TTL_SECONDS / 3)),
                );
                refreshRecommendationCacheInBackground({ userId: loggedInUserId });
            } else {
                logger.info(`[SmartUsers] Seed batch empty for ${loggedInUserId}. Falling back to full warmup...`);
                cachedBatch = await warmRecommendationCacheForUser(loggedInUserId);
                if (!cachedBatch || !cachedBatch.users) {
                    cachedBatch = await getCachedRecommendationBatch(loggedInUserId);
                }
            }
        }

        const validExcludedIds = [...excludeArray, ...persistentExcludedIds];
        const refreshedUsers = selectRefreshUsers(cachedBatch?.users || [], validExcludedIds, {
            limit: SMART_RECOMMENDATION_RESPONSE_SIZE,
        });

        logger.info(`[SmartUsers] Smart Delivery Mode returning ${refreshedUsers.length} top candidates.`);
        res.json(refreshedUsers);
    } catch (err) {
        logger.error("[SmartUsers] CRITICAL FAILURE:", err);
        res.status(500).json({
            message: "Failed to fetch smart connections",
        });
    }
};

module.exports = {
    getRandomUser,
    getSmartUsers,
};
