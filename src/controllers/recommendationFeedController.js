const { createHash } = require("crypto");
const { prisma } = require("../../prisma/prismaClient");
const fs = require('fs');

const {
  LOG_FILE,
  axios,
  redisClient,
  PLACEHOLDER_VALUES,
  parseNumber,
  MAX_FEEDBACK_EVENTS,
  SMART_RECOMMENDATION_BATCH_SIZE,
  SMART_RECOMMENDATION_RESPONSE_SIZE,
  SMART_RECOMMENDATION_CACHE_TTL_SECONDS,
  AI_MATCH_TIMEOUT_MS,
  NOT_PREFERRED_EXCLUSION_DAYS,
  RECOMMENDATION_CONFIG,
  SMART_RECOMMENDATION_SOURCES,
  RECOMMENDATION_FEEDBACK_ACTIONS,
  RECOMMENDATION_PREFERENCE_ACTIVE_STATUSES,
  RECOMMENDATION_PREVIEW_SELECT,
  normalizeText,
  isMeaningfulText,
  normalizeTerms,
  getNestedObject,
  getExplicitPreferenceValue,
  summarizeList,
  tokenize,
  buildExplicitPreferenceProfile,
  buildProfileSignals,
  detectExperienceLevel,
  getProfileQualityScore,
  getProfileQualityLabel,
  isDiscoverableProfile,
  clamp,
  recommendationCacheMemory,
  getRecommendationCacheKey,
  getRecommendationCachePayload,
  getRecommendationCacheHash,
  getMemoryCachedRecommendations,
  setMemoryCachedRecommendations,
  deleteMemoryCachedRecommendations,
  getCachedRecommendationBatch,
  setCachedRecommendationBatch,
  invalidateRecommendationCache,
  detectProfileType,
  detectLocationBucket,
  detectBackgroundKey,
  getClusterKey,
  buildCandidateActivitySummary,
  getActivityRecencyScore,
  createWeightedMap,
  addWeightedTerms,
  getFeedbackRecencyMultiplier,
  isWithinRecentDays,
  buildFeedbackProfile,
  getTopWeightedTerms,
  buildHistoryProfile,
  buildCompositeMatchingProfile,
  getWeightedSum,
  applyFeedbackToRankings,
  selectBalancedRankings,
  trackRecommendationEvents,
  trackRecommendationEvent,
  mapPreferenceStatusToFeedbackAction,
  upsertRecommendationPreference,
  clearRecommendationPreference,
  getRecommendationSource,
  getRecommendationMetadata,
  getFeedbackCandidateIds,
  getRecommendationHistoryEvents,
  getCandidatePreviewMap,
  formatRecommendationTimeline,
  pickLatestEventsByCandidate,
  createSectionItem,
  buildRecommendationSections,
  summarizeRecommendationHistory,
  incrementBucket,
  mapToSortedObject,
  buildActionTrend,
  buildRecommendationAnalyticsSnapshot,
  getLatestInterestedEventSource,
  getSharedItems,
  getMatchConfidence,
  scoreExplicitPreferenceMatch,
  scoreCandidateReadiness,
  buildFallbackRankings,
  buildSmartUserPayload,
  filterUsersForResponse,
  trackShownCandidates,
  getPersistentExcludedIds,
  getEligibleRecommendationCandidates,
  getFeedbackProfileForUser,
  getAcceptedConnectionsForUser,
  getCandidateActivityMap,
  decorateCandidatesForRanking,
  mergeRankingsWithFallback,
  buildRankedRecommendationBatch,
  getMatchingAgentPayload,
  refreshRecommendationCacheInBackground,
  prepareSmartRecommendationContext,
  warmRecommendationCacheForUser
} = require('../utils/recommendationUtils');

const getRandomUser = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;

        const connections = await prisma.connectionsRequest.findMany({
            where: {
                OR: [
                    { toUserId: loggedInUserId },
                    { fromUserId: loggedInUserId },
                ],
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

        res.json(randomUser[0]);
    } catch (err) {
        res.status(500).json({
            message: "Internal Server Error",
            error: err.message,
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

const selectRefreshUsers = (users = [], excludedIds = [], {
    limit = SMART_RECOMMENDATION_RESPONSE_SIZE,
    windowSize = 12,
} = {}) => {
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

        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Request from ${loggedInUserId}, excludeCount: ${excludeArray.length}\n`);

        console.log(`[SmartUsers] Request from ${loggedInUserId}, excludeCount: ${excludeArray.length}`);

        if (isRefreshRequest) {
            await invalidateRecommendationCache(loggedInUserId);
            console.log(`[SmartUsers] Cache invalidated for user ${loggedInUserId} (refresh requested)`);
        }

        let [persistentExcludedIds, cachedBatch] = await Promise.all([
            getPersistentExcludedIds(loggedInUserId),
            getCachedRecommendationBatch(loggedInUserId),
        ]);
        fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Exclusions: ${persistentExcludedIds.length}, Cache: ${cachedBatch?.users?.length || 0}\n`);

        if (!cachedBatch || !cachedBatch.users || cachedBatch.users.length === 0 || isRefreshRequest) {
            console.log(`[SmartUsers] Cache miss for ${loggedInUserId}. Preparing fast seed batch...`);

            const seedCandidates = await getEligibleRecommendationCandidates(
                loggedInUserId,
                persistentExcludedIds,
                { take: Math.max(SMART_RECOMMENDATION_BATCH_SIZE * 2, 24) }
            );
            const seedUsers = buildSeedRecommendationBatch(seedCandidates, SMART_RECOMMENDATION_BATCH_SIZE);

            if (seedUsers.length > 0) {
                cachedBatch = getRecommendationCachePayload(seedUsers, "seed");
                await setCachedRecommendationBatch(
                    loggedInUserId,
                    cachedBatch,
                    Math.max(30, Math.floor(SMART_RECOMMENDATION_CACHE_TTL_SECONDS / 3))
                );
                refreshRecommendationCacheInBackground({ userId: loggedInUserId });
            } else {
                console.log(`[SmartUsers] Seed batch empty for ${loggedInUserId}. Falling back to full warmup...`);
                cachedBatch = await warmRecommendationCacheForUser(loggedInUserId);
                if (!cachedBatch || !cachedBatch.users) {
                    cachedBatch = await getCachedRecommendationBatch(loggedInUserId);
                }
            }
        }

        const validExcludedIds = [...excludeArray, ...persistentExcludedIds];
        const refreshedUsers = selectRefreshUsers(cachedBatch?.users || [], validExcludedIds, { 
            limit: SMART_RECOMMENDATION_RESPONSE_SIZE 
        });

        console.log(`[SmartUsers] Smart Delivery Mode returning ${refreshedUsers.length} top candidates.`);
        res.json(refreshedUsers);

    } catch (err) {
        console.error("[SmartUsers] CRITICAL FAILURE:", err);
        res.status(500).json({
            message: "Failed to fetch smart connections",
            error: err.message,
            stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
        });
    }
};


module.exports = {
  getRandomUser,
  getSmartUsers
};
