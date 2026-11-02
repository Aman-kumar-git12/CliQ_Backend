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
            return res.status(401).json({ message: "Authentication required" });
        }

        const { excludeIds = [], refresh = "false" } = req.query;
        const isRefreshRequest = refresh === "true";
        // Malformed ids would make the database query below fail with a 500
        const excludeArray = (Array.isArray(excludeIds) ? excludeIds : [excludeIds]).filter(
            (id) => typeof id === "string" && /^[0-9a-fA-F]{24}$/.test(id),
        );

        logger.info(`[SmartUsers] Request from ${loggedInUserId}, excludeCount: ${excludeArray.length}`);

        // Refresh shows a new sample of the current list straight away and re-ranks in the background;
        // it never makes the user wait for ranking or the AI agent
        if (isRefreshRequest) {
            await invalidateRecommendationCache(loggedInUserId);
            logger.info(`[SmartUsers] Refresh requested by ${loggedInUserId}: re-ranking in the background`);
        }

        let [persistentExcludedIds, cachedBatch] = await Promise.all([
            getPersistentExcludedIds(loggedInUserId),
            getCachedRecommendationBatch(loggedInUserId),
        ]);
        logger.debug(
            `[SmartUsers] Exclusions: ${persistentExcludedIds.length}, Cache: ${cachedBatch?.users?.length || 0}`,
        );

        if (cachedBatch?.isStale || isRefreshRequest) {
            refreshRecommendationCacheInBackground({ userId: loggedInUserId });
        }

        if (!cachedBatch || !cachedBatch.users || cachedBatch.users.length === 0) {
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
        let refreshedUsers = selectRefreshUsers(cachedBatch?.users || [], validExcludedIds, {
            limit: SMART_RECOMMENDATION_RESPONSE_SIZE,
        });

        // Everyone in the list was already seen: show quick picks now; the background ranking fills the next list
        if (refreshedUsers.length === 0 && cachedBatch?.users?.length > 0) {
            refreshRecommendationCacheInBackground({ userId: loggedInUserId });
            const seedCandidates = await getEligibleRecommendationCandidates(loggedInUserId, validExcludedIds, {
                take: SMART_RECOMMENDATION_RESPONSE_SIZE,
            });
            refreshedUsers = buildSeedRecommendationBatch(seedCandidates, SMART_RECOMMENDATION_RESPONSE_SIZE);
        }

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
    getSmartUsers,
};
