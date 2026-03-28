const fs = require("fs");
const axios = require("axios");
const { LOG_FILE, AI_MATCH_TIMEOUT_MS, SMART_RECOMMENDATION_BATCH_SIZE, SMART_RECOMMENDATION_RESPONSE_SIZE } = require("./constants");
const { prisma } = require("../../../prisma/prismaClient");
const { getPersistentExcludedIds, getEligibleRecommendationCandidates, getAcceptedConnectionsForUser, getFeedbackCandidateIds } = require("./dataFetching");
const { buildHistoryProfile, buildCompositeMatchingProfile } = require("./history");
const { buildFeedbackProfile } = require("./feedback");
const { buildFallbackRankings } = require("./scoring");
const { buildRankedRecommendationBatch } = require("./ranking");
const { setCachedRecommendationBatch, getRecommendationCachePayload, SMART_RECOMMENDATION_CACHE_TTL_SECONDS } = require("./caching");

const getMatchingAgentPayload = (userExpertise = {}, historyProfile = null, candidates = []) => ({
    userProfile: userExpertise,
    historyProfile,
    topK: Math.max(SMART_RECOMMENDATION_BATCH_SIZE * 3, SMART_RECOMMENDATION_RESPONSE_SIZE),
    candidates: candidates.map((candidate) => ({
        id: candidate.id,
        firstname: candidate.firstname,
        lastname: candidate.lastname,
        age: candidate.age,
        imageUrl: candidate.imageUrl,
        email: candidate.email,
        expertise: candidate.expertise || {},
    })),
});

const refreshRecommendationCacheInBackground = ({
    userId,
    userExpertise,
    historyProfile,
    candidates,
    fallbackRankings,
    feedbackProfile,
}) => {
    if (!userId || !Array.isArray(candidates) || candidates.length === 0) return;

    const llmServiceUrl = process.env.LLM_SERVICE_URL || "http://localhost:8000";

    Promise.resolve()
        .then(async () => {
            let rankedResults = fallbackRankings;
            let strategy = "fallback";

            try {
                const agentResponse = await axios.post(
                    `${llmServiceUrl}/api/match/match`,
                    getMatchingAgentPayload(userExpertise || {}, historyProfile, candidates),
                    { timeout: AI_MATCH_TIMEOUT_MS }
                );

                if (Array.isArray(agentResponse.data?.rankedResults) && agentResponse.data.rankedResults.length > 0) {
                    rankedResults = agentResponse.data.rankedResults;
                    strategy = "ai";
                }
            } catch (agentError) {
                console.error("AI Smart Matching warm-cache failed:", agentError.message);
            }

            const users = buildRankedRecommendationBatch({
                candidates,
                fallbackRankings,
                rankedResults,
                feedbackProfile,
                userExpertise,
                limit: SMART_RECOMMENDATION_BATCH_SIZE,
            });

            if (users.length > 0) {
                await setCachedRecommendationBatch(userId, getRecommendationCachePayload(users, strategy));
            }
        })
        .catch((error) => {
            console.error("Recommendation background refresh failed:", error.message);
        });
};

const prepareSmartRecommendationContext = async (loggedInUserId) => {
  if (fs.existsSync(LOG_FILE)) {
    fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] Context: Fetching user ${loggedInUserId}...\n`);
  }
    const user = await prisma.users.findUnique({
        where: { id: loggedInUserId },
        select: { id: true, expertise: true },
    });

    const persistentExcludedIds = await getPersistentExcludedIds(loggedInUserId);

    const [eligibleCandidates, feedbackEvents, acceptedConnections] = await Promise.all([
        getEligibleRecommendationCandidates(loggedInUserId, persistentExcludedIds),
        getFeedbackCandidateIds(loggedInUserId),
        getAcceptedConnectionsForUser(loggedInUserId),
    ]);

    // Note: getFeedbackProfileForUser in original was separate, but we can build it here
    const feedbackCandidateIds = [...new Set(feedbackEvents.map((event) => event.candidateUserId))];
    let feedbackProfile = null;
    if (feedbackCandidateIds.length > 0) {
        const feedbackCandidates = await prisma.users.findMany({
            where: { id: { in: feedbackCandidateIds } },
            select: { id: true, expertise: true },
        });
        const feedbackCandidateMap = new Map(feedbackCandidates.map((c) => [c.id, c]));
        feedbackProfile = buildFeedbackProfile(feedbackEvents, feedbackCandidateMap);
    }

    // We need activity map which was in dataFetching or matching? original had getCandidateActivityMap
    // I missed getCandidateActivityMap and decorateCandidatesForRanking in previous step.
    // I'll add them to dataFetching or a new helper.
    // Let's assume they are exported from another file if I move them.
    // I'll put the activity logic in dataFetching.js next.
    
    return {
        user,
        persistentExcludedIds,
        eligibleCandidates,
        feedbackProfile,
        acceptedConnections,
    };
};

const warmRecommendationCacheForUser = async (loggedInUserId) => {
    if (!loggedInUserId) return null;

    try {
        console.log(`[Warmup] Starting for user ${loggedInUserId}`);
        const context = await prepareSmartRecommendationContext(loggedInUserId);

        if (context.eligibleCandidates.length === 0) {
            console.log(`[Warmup] No eligible candidates for ${loggedInUserId}`);
            await setCachedRecommendationBatch(
                loggedInUserId,
                getRecommendationCachePayload([], "empty"),
                Math.max(30, Math.floor(SMART_RECOMMENDATION_CACHE_TTL_SECONDS / 3))
            );
            return context;
        }

        refreshRecommendationCacheInBackground({
            userId: loggedInUserId,
            userExpertise: context.compositeUserProfile || context.user?.expertise || {},
            historyProfile: context.historyProfile,
            candidates: context.eligibleCandidates,
            fallbackRankings: context.fallbackRankings,
            feedbackProfile: context.feedbackProfile,
        });

        return context;
    } catch (error) {
        console.error(`[Warmup] Failed for ${loggedInUserId}:`, error.message);
        return null;
    }
};

module.exports = {
    getMatchingAgentPayload,
    refreshRecommendationCacheInBackground,
    prepareSmartRecommendationContext,
    warmRecommendationCacheForUser,
};
