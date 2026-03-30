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

const getConnectionStatus = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const otherUserId = req.params.userId;

        const connection = await prisma.connectionsRequest.findFirst({
            where: {
                OR: [
                    { fromUserId: loggedInUserId, toUserId: otherUserId },
                    { fromUserId: otherUserId, toUserId: loggedInUserId },
                ],
            },
        });

        if (!connection) {
            return res.json({
                status: "none",
                message: "No connection exists between these users",
            });
        }

        return res.json({
            status: connection.status,
            connection,
        });
    } catch (err) {
        return res.status(500).json({
            message: "Internal Server Error",
            error: err.message,
        });
    }
};

const deleteRequest = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const requestId = req.params.requestId;

        const findRequest = await prisma.connectionsRequest.findUnique({
            where: { id: requestId },
        });

        if (!findRequest || findRequest.toUserId !== loggedInUserId) {
            return res.status(404).json({ message: "Connection request not found" });
        }

        const deleted = await prisma.connectionsRequest.delete({
            where: { id: requestId },
        });

        res.json({ message: "Connection request deleted successfully", deleted });
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const sendRequest = async (req, res) => {
    try {
        const fromUserId = req.user.id;
        const toUserId = req.params.toUserId;
        const status = req.params.status;
        const source = getRecommendationSource(req);
        const requestMetadata = getRecommendationMetadata(req);
        const trackedAction = status === "interested"
            ? "interested"
            : status === "ignored"
                ? "ignored"
                : null;

        const toUser = await prisma.users.findUnique({
            where: { id: toUserId },
        });

        if (!toUser) {
            return res.status(404).json({ message: "Recipient user not found" });
        }

        const exists = await prisma.connectionsRequest.findFirst({
            where: {
                OR: [
                    { fromUserId: fromUserId, toUserId: toUserId },
                    { fromUserId: toUserId, toUserId: fromUserId },
                ],
            },
        });

        if (exists) {
            if (exists.status === "ignored") {
                const updated = await prisma.connectionsRequest.update({
                    where: { id: exists.id },
                    data: {
                        fromUserId,
                        toUserId,
                        status,
                        updatedAt: new Date(),
                    },
                });
                if (trackedAction) {
                    await trackRecommendationEvent({
                        userId: fromUserId,
                        candidateUserId: toUserId,
                        action: trackedAction,
                        source: source || "manual_request",
                        metadata: getRecommendationMetadata(req, { requestId: updated.id, resent: true })
                    });
                }
                await invalidateRecommendationCache(fromUserId, toUserId);
                return res.json({
                    message: status === "ignored"
                        ? "User ignored"
                        : "Request sent (resend after ignored)",
                    data: updated
                });
            }
            return res.status(409).json({ message: "Connection already exists", existing: exists });
        }

        const data = await prisma.connectionsRequest.create({
            data: {
                fromUserId,
                toUserId,
                status,
            },
        });

        if (trackedAction) {
            await trackRecommendationEvent({
                userId: fromUserId,
                candidateUserId: toUserId,
                action: trackedAction,
                source: source || "manual_request",
                metadata: {
                    ...requestMetadata,
                    requestId: data.id,
                }
            });
        }

        await invalidateRecommendationCache(fromUserId, toUserId);

        return res.json({
            message: status === "ignored" ? "User ignored" : "Request sent successfully",
            data
        });
    } catch (err) {
        if (err?.code === "P2002") {
            return res.status(409).json({ message: "Connection already exists" });
        }
        return res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const reviewRequest = async (req, res) => {
    try {
        const { status, requestId } = req.params;
        const loggedInUserId = req.user.id;

        const findConnections = await prisma.connectionsRequest.findUnique({
            where: { id: requestId },
        });

        if (!findConnections || findConnections.toUserId !== loggedInUserId) {
            return res.status(404).json({ message: "Connection request not found" });
        }

        const data = await prisma.connectionsRequest.update({
            where: { id: requestId },
            data: { status },
        });

        await invalidateRecommendationCache(data.fromUserId, data.toUserId);

        res.json({ message: "Connections Reviewed Successfully", data });
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};


module.exports = {
  getConnectionStatus,
  deleteRequest,
  sendRequest,
  reviewRequest
};
