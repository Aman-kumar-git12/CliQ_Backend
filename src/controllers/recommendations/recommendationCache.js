const axios = require("axios");
const { config } = require("../../config");
const {
    invalidateRecommendationCache,
    refreshRecommendationCacheInBackground,
} = require("../../utils/recommendations");
const logger = require("../../utils/logger");

const clearRecommendationCacheForUser = async (userId) => {
    if (!userId) return;
    try {
        await invalidateRecommendationCache(userId);
    } catch (error) {
        logger.error("Failed to clear recommendation cache:", error.message);
    }
};

const precomputeProfileEmbedding = (userId, expertise) => {
    const agentUrl = config.agent.url;

    Promise.resolve()
        .then(() =>
            axios.post(
                `${agentUrl}/api/match/precompute`,
                {
                    profileId: userId,
                    profile: expertise || {},
                },
                { timeout: 2000, headers: config.agent.authHeaders },
            ),
        )
        .catch((error) => {
            logger.error("Profile embedding precompute failed:", error.message);
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
            logger.error("Recommendation feed prewarm failed:", error.message);
        });
};

module.exports = {
    clearRecommendationCacheForUser,
    precomputeProfileEmbedding,
    primeRecommendationFeedForUser,
};
