const fs = require("fs");
const axios = require("axios");
const { LOG_FILE, AI_MATCH_TIMEOUT_MS, SMART_RECOMMENDATION_BATCH_SIZE, SMART_RECOMMENDATION_RESPONSE_SIZE } = require("./constants");
const { prisma } = require("../../../prisma/prismaClient");
const {
    getPersistentExcludedIds,
    getEligibleRecommendationCandidates,
    getAcceptedConnectionsForUser,
    getFeedbackCandidateIds,
    getCandidateActivityMap,
    decorateCandidatesForRanking,
} = require("./dataFetching");
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

const rankCandidatesWithAgent = async ({
    userExpertise,
    historyProfile,
    candidates,
    fallbackRankings,
}) => {
    const llmServiceUrl = process.env.LLM_SERVICE_URL || "http://localhost:8000";
    let rankedResults = Array.isArray(fallbackRankings) ? fallbackRankings : [];
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
        console.error("AI Smart Matching failed:", agentError.message);
    }

    return { rankedResults, strategy };
};

const refreshRecommendationCacheInBackground = ({ userId }) => {
    if (!userId) return;

    Promise.resolve()
        .then(() => warmRecommendationCacheForUser(userId))
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

    const candidateActivityMap = await getCandidateActivityMap(eligibleCandidates.map((candidate) => candidate.id));
    const decoratedCandidates = decorateCandidatesForRanking(eligibleCandidates, candidateActivityMap);
    const historyProfile = buildHistoryProfile(user?.expertise || {}, feedbackProfile, acceptedConnections);
    const compositeUserProfile = buildCompositeMatchingProfile(user?.expertise || {}, historyProfile);
    const fallbackRankings = buildFallbackRankings(compositeUserProfile, decoratedCandidates);

    return {
        user,
        persistentExcludedIds,
        eligibleCandidates: decoratedCandidates,
        feedbackProfile,
        acceptedConnections,
        candidateActivityMap,
        historyProfile,
        compositeUserProfile,
        fallbackRankings,
    };
};

const warmRecommendationCacheForUser = async (loggedInUserId) => {
    if (!loggedInUserId) return null;

    try {
        console.log(`[Warmup] Starting for user ${loggedInUserId}`);
        const context = await prepareSmartRecommendationContext(loggedInUserId);
        if (!context?.user) {
            return null;
        }

        if (context.eligibleCandidates.length === 0) {
            console.log(`[Warmup] No eligible candidates for ${loggedInUserId}`);
            const emptyPayload = getRecommendationCachePayload([], "empty");
            await setCachedRecommendationBatch(
                loggedInUserId,
                emptyPayload,
                Math.max(30, Math.floor(SMART_RECOMMENDATION_CACHE_TTL_SECONDS / 3))
            );
            return emptyPayload;
        }

        const { rankedResults, strategy } = await rankCandidatesWithAgent({
            userExpertise: context.compositeUserProfile || context.user?.expertise || {},
            historyProfile: context.historyProfile,
            candidates: context.eligibleCandidates,
            fallbackRankings: context.fallbackRankings,
        });

        const users = buildRankedRecommendationBatch({
            candidates: context.eligibleCandidates,
            fallbackRankings: context.fallbackRankings,
            rankedResults,
            feedbackProfile: context.feedbackProfile,
            userExpertise: context.compositeUserProfile || context.user?.expertise || {},
            limit: SMART_RECOMMENDATION_BATCH_SIZE,
        });

        const payload = getRecommendationCachePayload(users, strategy);
        await setCachedRecommendationBatch(loggedInUserId, payload);
        return payload;
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
