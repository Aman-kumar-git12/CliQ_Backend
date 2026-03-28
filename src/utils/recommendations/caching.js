const { createHash } = require("crypto");
const redisClient = require("../../config/redisClient");
const { SMART_RECOMMENDATION_CACHE_TTL_SECONDS } = require("./constants");

const recommendationCacheMemory = new Map();

const getRecommendationCacheKey = (userId) => `smart_recommendations:v3:${userId}`;

const getRecommendationCachePayload = (users = [], strategy = "fallback") => ({
    users,
    strategy,
    cachedAt: new Date().toISOString(),
});

const getRecommendationCacheHash = (payload = {}) =>
    createHash("sha1").update(JSON.stringify(payload)).digest("hex");

const getMemoryCachedRecommendations = (key) => {
    const entry = recommendationCacheMemory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        recommendationCacheMemory.delete(key);
        return null;
    }
    return entry.value;
};

const setMemoryCachedRecommendations = (key, value, ttlSeconds) => {
    recommendationCacheMemory.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
    });
};

const deleteMemoryCachedRecommendations = (key) => {
    recommendationCacheMemory.delete(key);
};

const getCachedRecommendationBatch = async (userId) => {
    const cacheKey = getRecommendationCacheKey(userId);

    try {
        const isRedisReady = await redisClient.ensureReady?.();
        if (isRedisReady && redisClient?.isReady) {
            const raw = await redisClient.get(cacheKey);
            if (raw) {
                console.log(`[Cache] Hit for user ${userId}`);
                return JSON.parse(raw);
            }
        }
    } catch (error) {
        console.error(`[Cache] Read failed for user ${userId}:`, error.message);
    }

    console.log(`[Cache] Miss for user ${userId}, falling back to memory`);
    return getMemoryCachedRecommendations(cacheKey);
};

const setCachedRecommendationBatch = async (userId, payload, ttlSeconds = SMART_RECOMMENDATION_CACHE_TTL_SECONDS) => {
    const cacheKey = getRecommendationCacheKey(userId);
    const normalizedPayload = {
        ...payload,
        cacheHash: getRecommendationCacheHash(payload),
    };

    try {
        const isRedisReady = await redisClient.ensureReady?.();
        if (isRedisReady && redisClient?.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(normalizedPayload), { EX: ttlSeconds });
            return;
        }
    } catch (error) {
        console.error("Recommendation cache write failed:", error.message);
    }

    setMemoryCachedRecommendations(cacheKey, normalizedPayload, ttlSeconds);
};

const invalidateRecommendationCache = async (...userIds) => {
    const uniqueIds = [...new Set(userIds.flat().filter(Boolean))];
    if (uniqueIds.length === 0) return;

    await Promise.all(
        uniqueIds.map(async (userId) => {
            const cacheKey = getRecommendationCacheKey(userId);

            try {
                const isRedisReady = await redisClient.ensureReady?.();
                if (isRedisReady && redisClient?.isReady) {
                    await redisClient.del(cacheKey);
                }
            } catch (error) {
                console.error("Recommendation cache delete failed:", error.message);
            }

            deleteMemoryCachedRecommendations(cacheKey);
        })
    );
};

module.exports = {
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
};
