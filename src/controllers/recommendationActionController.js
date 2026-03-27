const { createHash } = require("crypto");
const { prisma } = require("../../prisma/prismaClient");
const fs = require('fs');

const {
  logFile,
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

const saveRecommendationCandidate = async (req, res) => {
    try {
        const userId = req.user.id;
        const candidateUserId = req.params.candidateUserId;
        const source = getRecommendationSource(req, "smart_connections");
        const metadata = getRecommendationMetadata(req, {
            feedbackTags: normalizeTerms(req.body?.feedbackTags),
        });

        if (userId === candidateUserId) {
            return res.status(400).json({ message: "You cannot save yourself" });
        }

        const candidate = await prisma.users.findUnique({
            where: { id: candidateUserId },
            select: RECOMMENDATION_PREVIEW_SELECT,
        });

        if (!candidate) {
            return res.status(404).json({ message: "Candidate user not found" });
        }

        const existing = await prisma.recommendationEvent.findFirst({
            where: {
                userId,
                candidateUserId,
                action: "saved",
                source,
            },
            orderBy: { createdAt: "desc" },
        });

        if (!existing) {
            await trackRecommendationEvent({
                userId,
                candidateUserId,
                action: "saved",
                source,
                metadata: {
                    ...metadata,
                    savedFrom: source,
                },
            });
        }
        await invalidateRecommendationCache(userId);

        res.json({
            message: existing ? "Profile already saved" : "Profile saved successfully",
            candidate,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

const trackRecommendationShown = async (req, res) => {
    try {
        const userId = req.user.id;
        const candidateUserId = req.params.candidateUserId;
        const source = getRecommendationSource(req, "smart_connections");
        const metadata = getRecommendationMetadata(req, {
            delivery: req.body?.delivery || "active_card",
        });

        if (!candidateUserId || userId === candidateUserId) {
            return res.status(400).json({ message: "Invalid candidate user" });
        }

        const candidate = await prisma.users.findUnique({
            where: { id: candidateUserId },
            select: { id: true },
        });

        if (!candidate) {
            return res.status(404).json({ message: "Candidate user not found" });
        }

        const recentShown = await prisma.recommendationEvent.findFirst({
            where: {
                userId,
                candidateUserId,
                action: "shown",
                source,
                createdAt: {
                    gte: new Date(Date.now() - 15 * 1000),
                },
            },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });

        if (!recentShown) {
            await trackRecommendationEvent({
                userId,
                candidateUserId,
                action: "shown",
                source,
                metadata,
            });
        }

        return res.json({
            tracked: !recentShown,
            message: recentShown ? "Shown already tracked recently" : "Shown tracked",
        });
    } catch (error) {
        return res.status(500).json({ message: "Failed to track shown state", error: error.message });
    }
};

const removeSavedRecommendation = async (req, res) => {
    try {
        const userId = req.user.id;
        const candidateUserId = req.params.candidateUserId;

        const deleted = await prisma.recommendationEvent.deleteMany({
            where: {
                userId,
                candidateUserId,
                action: "saved",
                source: { in: SMART_RECOMMENDATION_SOURCES },
            },
        });
        await invalidateRecommendationCache(userId);

        res.json({
            message: "Saved profile removed",
            removedCount: deleted.count,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

const removeRecommendationSectionItem = async (req, res) => {
    try {
        const userId = req.user.id;
        const { action, candidateUserId } = req.params;

        const validActions = ["shown", "saved", "interested", "ignored", "preferred", "my_interest", "not_preferred"];
        if (!validActions.includes(action)) {
            return res.status(400).json({ message: "Invalid section action" });
        }

        let removedCount = 0;

        if (action === "shown" || action === "saved") {
            const deleted = await prisma.recommendationEvent.deleteMany({
                where: {
                    userId,
                    candidateUserId,
                    action: action === "saved" ? "saved" : "shown",
                    source: { in: SMART_RECOMMENDATION_SOURCES.concat(["manual_toggle"]) },
                },
            });
            removedCount = deleted.count;
        } else if (action === "interested") {
            const deleted = await prisma.connectionsRequest.deleteMany({
                where: { fromUserId: userId, toUserId: candidateUserId, status: "interested" },
            });
            removedCount = deleted.count;
        } else if (action === "ignored") {
            const deleted = await prisma.recommendationEvent.deleteMany({
                where: { userId, candidateUserId, action: "ignored" }
            });
            removedCount = deleted.count;
        } else if (action === "my_interest" || action === "preferred" || action === "not_preferred") {
            const status = action === "my_interest" || action === "preferred"
                ? "preferred"
                : "not_preferred";

            const deleted = await prisma.recommendationPreference.deleteMany({
                where: { userId, candidateUserId, status }
            });
            removedCount = deleted.count;
        }

        await invalidateRecommendationCache(userId);
        res.json({ message: `${action} item removed`, removedCount });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

const resetRecommendationSection = async (req, res) => {
    try {
        const userId = req.user.id;
        const { action } = req.params;

        const validActions = ["shown", "saved", "interested", "ignored", "preferred", "my_interest", "not_preferred"];
        if (!validActions.includes(action)) {
            return res.status(400).json({ message: "Invalid section action" });
        }

        if (action === "shown" || action === "saved") {
            await prisma.recommendationEvent.deleteMany({
                where: {
                    userId,
                    action: action === "saved" ? "saved" : "shown",
                },
            });
        } else if (action === "interested") {
            await prisma.connectionsRequest.deleteMany({
                where: { fromUserId: userId, status: "interested" },
            });
        } else if (action === "ignored") {
            await prisma.recommendationEvent.deleteMany({
                where: { userId, action: "ignored" }
            });
        } else if (action === "my_interest" || action === "preferred" || action === "not_preferred") {
            const status = action === "my_interest" || action === "preferred"
                ? "preferred"
                : "not_preferred";

            await prisma.recommendationPreference.deleteMany({
                where: { userId, status }
            });
        }

        await invalidateRecommendationCache(userId);
        res.json({ success: true, message: `${action} section reset successful` });
    } catch (error) {
        res.status(500).json({ message: "Failed to reset section", error: error.message });
    }
};

const toggleUserInterest = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const { candidateUserId } = req.params;
        const metadata = getRecommendationMetadata(req, {
            preferenceReason: normalizeText(req.body?.preferenceReason || req.body?.reason),
            feedbackTags: normalizeTerms(req.body?.feedbackTags),
        });

        const existing = await prisma.recommendationPreference.findFirst({
            where: {
                userId: loggedInUserId,
                candidateUserId,
            }
        });

        if (existing?.status === "preferred") {
            return res.json({
                success: true,
                updated: false,
                isInterested: true,
                status: "preferred",
                message: "Already marked as preferred",
            });
        }

        await prisma.recommendationPreference.upsert({
            where: { userId_candidateUserId: { userId: loggedInUserId, candidateUserId } },
            update: { status: "preferred", metadata },
            create: { userId: loggedInUserId, candidateUserId, status: "preferred", metadata }
        });

        await invalidateRecommendationCache(loggedInUserId);
        res.json({
            success: true,
            updated: true,
            isInterested: true,
            status: "preferred",
            message: "Marked as preferred",
        });
    } catch (error) {
        res.status(500).json({ message: "Failed to toggle interest", error: error.message });
    }
};

const toggleUserNotInterest = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const { candidateUserId } = req.params;
        const metadata = getRecommendationMetadata(req, {
            ignoreReason: normalizeText(req.body?.ignoreReason || req.body?.reason),
            feedbackTags: normalizeTerms(req.body?.feedbackTags),
        });

        const existing = await prisma.recommendationPreference.findFirst({
            where: { userId: loggedInUserId, candidateUserId }
        });

        if (existing?.status === "not_preferred") {
            return res.json({
                success: true,
                updated: false,
                isNotInterested: true,
                status: "not_preferred",
                message: "Already marked as not preferred",
            });
        }

        await prisma.recommendationPreference.upsert({
            where: { userId_candidateUserId: { userId: loggedInUserId, candidateUserId } },
            update: { status: "not_preferred", metadata },
            create: { userId: loggedInUserId, candidateUserId, status: "not_preferred", metadata }
        });

        await invalidateRecommendationCache(loggedInUserId, candidateUserId);

        res.json({
            success: true,
            updated: true,
            isNotInterested: true,
            status: "not_preferred",
            message: "Marked as not preferred",
        });
    } catch (error) {
        res.status(500).json({ message: "Failed to toggle not-interest", error: error.message });
    }
};

const clearRecommendationCacheForUser = async (userId) => {
    if (!userId) return;
    try {
        if (redisClient?.isReady) {
            const cacheKey = getRecommendationCacheKey(userId);
            await redisClient.del(cacheKey);
        }
    } catch (error) {
        console.error("Failed to clear recommendation cache:", error.message);
    }
};

const precomputeProfileEmbedding = (userId, expertise) => {
    const agentUrl = process.env.LLM_SERVICE_URL || "http://localhost:8000";

    Promise.resolve()
        .then(() =>
            axios.post(
                `${agentUrl}/api/match/precompute`,
                {
                    profileId: userId,
                    profile: expertise || {},
                },
                { timeout: 2000 }
            )
        )
        .catch((error) => {
            console.error("Profile embedding precompute failed:", error.message);
        });
};

module.exports = {
    trackRecommendationShown,
    saveRecommendationCandidate,
    removeSavedRecommendation,
    removeRecommendationSectionItem,
    resetRecommendationSection,
    toggleUserInterest,
    toggleUserNotInterest,
    clearRecommendationCacheForUser,
    precomputeProfileEmbedding,
};
