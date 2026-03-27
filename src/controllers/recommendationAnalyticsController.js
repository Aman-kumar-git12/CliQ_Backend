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

const getSavedRecommendations = async (req, res) => {
    try {
        const userId = req.user.id;
        const events = await prisma.recommendationEvent.findMany({
            where: {
                userId,
                action: "saved",
                source: { in: SMART_RECOMMENDATION_SOURCES },
            },
            orderBy: { createdAt: "desc" },
            take: 200,
        });

        const latestSavedEventByCandidate = new Map();
        events.forEach((event) => {
            if (!latestSavedEventByCandidate.has(event.candidateUserId)) {
                latestSavedEventByCandidate.set(event.candidateUserId, event);
            }
        });

        const candidateMap = await getCandidatePreviewMap([...latestSavedEventByCandidate.keys()]);
        const savedProfiles = [...latestSavedEventByCandidate.values()]
            .map((event) => ({
                id: event.id,
                savedAt: event.createdAt,
                source: event.source,
                candidate: candidateMap.get(event.candidateUserId) || null,
            }))
            .filter((item) => item.candidate);

        res.json({
            savedProfiles,
            count: savedProfiles.length,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

const getRecommendationHistory = async (req, res) => {
    try {
        const userId = req.user.id;
        const events = await getRecommendationHistoryEvents(userId, 150);
        const candidateMap = await getCandidatePreviewMap(events.map((event) => event.candidateUserId));
        const sections = await buildRecommendationSections(userId);
        const summary = summarizeRecommendationHistory(events);
        const counts = {
            ...summary.counts,
            interested: sections.interested.length,
        };
        const shown = counts.shown || 0;

        res.json({
            counts,
            conversion: {
                ...summary.conversion,
                interestRate: shown > 0 ? Number(((counts.interested || 0) / shown).toFixed(3)) : 0,
            },
            sections,
            timeline: formatRecommendationTimeline(events, candidateMap),
            totalEvents: events.length,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

const getRecommendationAnalytics = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const events = await getRecommendationHistoryEvents(loggedInUserId, 500);
        const summary = buildRecommendationAnalyticsSnapshot(events, "personal");

        res.json({
            counts: summary.counts,
            conversion: summary.conversion,
            uniqueCandidates: summary.uniqueCandidates,
            sourceBreakdown: summary.sourceBreakdown,
            deliveryBreakdown: summary.deliveryBreakdown,
            confidenceBreakdown: summary.confidenceBreakdown,
            profileQualityBreakdown: summary.profileQualityBreakdown,
            selectionModeBreakdown: summary.selectionModeBreakdown,
            diversityBreakdown: summary.diversityBreakdown,
            trend: summary.trend,
            funnel: summary.funnel,
            sampleSize: events.length,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

const getRecommendationAdminAnalytics = async (req, res) => {
    try {
        const [events, distinctUsers, totalUsers] = await Promise.all([
            prisma.recommendationEvent.findMany({
                where: {
                    source: { in: SMART_RECOMMENDATION_SOURCES },
                },
                orderBy: { createdAt: "desc" },
                take: 5000,
            }),
            prisma.recommendationEvent.findMany({
                where: {
                    source: { in: SMART_RECOMMENDATION_SOURCES },
                },
                distinct: ["userId"],
                select: { userId: true },
            }),
            prisma.users.count(),
        ]);

        const snapshot = buildRecommendationAnalyticsSnapshot(events, "system");
        const activeUsers = distinctUsers.length;

        res.json({
            label: snapshot.label,
            counts: snapshot.counts,
            conversion: snapshot.conversion,
            uniqueCandidates: snapshot.uniqueCandidates,
            activeUsers,
            totalUsers,
            coverageRate: totalUsers > 0 ? Number((activeUsers / totalUsers).toFixed(3)) : 0,
            sourceBreakdown: snapshot.sourceBreakdown,
            deliveryBreakdown: snapshot.deliveryBreakdown,
            confidenceBreakdown: snapshot.confidenceBreakdown,
            profileQualityBreakdown: snapshot.profileQualityBreakdown,
            selectionModeBreakdown: snapshot.selectionModeBreakdown,
            diversityBreakdown: snapshot.diversityBreakdown,
            trend: snapshot.trend,
            funnel: snapshot.funnel,
            sampleSize: events.length,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

const getInterestedUsers = async (req, res) => {
    try {
        const requests = await prisma.connectionsRequest.findMany({
            where: { fromUserId: req.user.id, status: "interested" },
            orderBy: { updatedAt: "desc" },
            select: { toUserId: true },
        });
        const candidateIds = requests.map((request) => request.toUserId);
        const users = await prisma.users.findMany({
            where: { id: { in: candidateIds } },
            select: {
                id: true, firstname: true, lastname: true, expertise: true, imageUrl: true, email: true, age: true,
            }
        });
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch interested users", error: error.message });
    }
};

const getNotInterestedUsers = async (req, res) => {
    try {
        const preferences = await prisma.recommendationPreference.findMany({
            where: { userId: req.user.id, status: "not_preferred" },
            orderBy: { updatedAt: "desc" },
            select: { candidateUserId: true },
        });
        const candidateIds = preferences.map((preference) => preference.candidateUserId);
        const users = await prisma.users.findMany({
            where: { id: { in: candidateIds } },
            select: {
                id: true, firstname: true, lastname: true, expertise: true, imageUrl: true, email: true, age: true,
            }
        });
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch not-interested users", error: error.message });
    }
};

const getInterestedPreferences = async (req, res) => {
    try {
        const userId = req.user.id;
        const preferences = await prisma.recommendationPreference.findMany({
            where: { userId, status: "preferred" },
            select: { candidateUserId: true }
        });

        const candidateIds = preferences.map(p => p.candidateUserId);
        const users = await prisma.users.findMany({
            where: { id: { in: candidateIds } },
            select: RECOMMENDATION_PREVIEW_SELECT
        });

        res.json(users);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch interested preferences", error: error.message });
    }
};

const getNotInterestedPreferences = async (req, res) => {
    try {
        const userId = req.user.id;
        const preferences = await prisma.recommendationPreference.findMany({
            where: { userId, status: "not_preferred" },
            select: { candidateUserId: true }
        });

        const candidateIds = preferences.map(p => p.candidateUserId);
        const users = await prisma.users.findMany({
            where: { id: { in: candidateIds } },
            select: RECOMMENDATION_PREVIEW_SELECT
        });

        res.json(users);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch not-interested preferences", error: error.message });
    }
};


module.exports = {
  getSavedRecommendations,
  getRecommendationHistory,
  getRecommendationAnalytics,
  getRecommendationAdminAnalytics,
  getInterestedUsers,
  getNotInterestedUsers,
  getInterestedPreferences,
  getNotInterestedPreferences
};
