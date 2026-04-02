const axios = require("axios");
const {
    invalidateRecommendationCache,
    refreshRecommendationCacheInBackground,
} = require("../../utils/recommendationUtils");

const clearRecommendationCacheForUser = async (userId) => {
    if (!userId) return;
    try {
        await invalidateRecommendationCache(userId);
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

const primeRecommendationFeedForUser = (userId, expertise) => {
    if (!userId) return;

    Promise.resolve()
        .then(() => {
            precomputeProfileEmbedding(userId, expertise || {});
            refreshRecommendationCacheInBackground({ userId });
        })
        .catch((error) => {
            console.error("Recommendation feed prewarm failed:", error.message);
        });
};

module.exports = {
    clearRecommendationCacheForUser,
    precomputeProfileEmbedding,
    primeRecommendationFeedForUser,
};
