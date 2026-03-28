const axios = require("axios");
const {
    redisClient,
    getRecommendationCacheKey
} = require("../../utils/recommendationUtils");

const clearRecommendationCacheForUser = async (userId) => {
    if (!userId) return;
    try {
        const isRedisReady = await redisClient.ensureReady?.();
        if (isRedisReady && redisClient?.isReady) {
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

module.exports = { clearRecommendationCacheForUser, precomputeProfileEmbedding };
