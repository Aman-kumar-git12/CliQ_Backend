const { createHash } = require("crypto");
const redisClient = require("../../config/redisClient");
const { SMART_RECOMMENDATION_CACHE_TTL_SECONDS } = require("./constants");
const { saveStoredList, loadStoredList, markStoredListsStale } = require("./storedList");
const logger = require("../logger");

const recommendationCacheMemory = new Map();

const getRecommendationCacheKey = (userId) => `smart_recommendations:v3:${userId}`;

const getRecommendationCachePayload = (users = [], strategy = "fallback") => ({
    users,
    strategy,
    cachedAt: new Date().toISOString(),
});

const getRecommendationCacheHash = (payload = {}) => createHash("sha1").update(JSON.stringify(payload)).digest("hex");

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

// Redis (or this process's memory) is a short-lived hot copy; the stored list in MongoDB outlives it
const writeHotCopy = async (cacheKey, payload, ttlSeconds) => {
    try {
        const isRedisReady = await redisClient.ensureReady?.();
        if (isRedisReady && redisClient?.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(payload), { EX: ttlSeconds });
            return;
        }
    } catch (error) {
        logger.error("Recommendation cache write failed:", error.message);
    }

    setMemoryCachedRecommendations(cacheKey, payload, ttlSeconds);
};

const getCachedRecommendationBatch = async (userId) => {
    const cacheKey = getRecommendationCacheKey(userId);

    try {
        const isRedisReady = await redisClient.ensureReady?.();
        if (isRedisReady && redisClient?.isReady) {
            const raw = await redisClient.get(cacheKey);
            if (raw) {
                logger.info(`[Cache] Hit for user ${userId}`);
                return JSON.parse(raw);
            }
        }
    } catch (error) {
        logger.error(`[Cache] Read failed for user ${userId}:`, error.message);
    }

    const inMemory = getMemoryCachedRecommendations(cacheKey);
    if (inMemory) return inMemory;

    const stored = await loadStoredList(userId);
    if (stored) {
        logger.info(`[Cache] Served stored list for user ${userId}${stored.isStale ? " (stale)" : ""}`);
        await writeHotCopy(cacheKey, stored, SMART_RECOMMENDATION_CACHE_TTL_SECONDS);
        return stored;
    }

    logger.info(`[Cache] Miss for user ${userId}`);
    return null;
};

// rankedFrom: when the ranking behind payload started (see saveStoredList); defaults to now
const setCachedRecommendationBatch = async (
    userId,
    payload,
    ttlSeconds = SMART_RECOMMENDATION_CACHE_TTL_SECONDS,
    { rankedFrom } = {},
) => {
    const cacheKey = getRecommendationCacheKey(userId);
    // A change made while this list was being ranked keeps it stale, so the next read ranks it again
    const { stale } = (await saveStoredList(userId, payload, { rankedFrom })) || {};
    const normalizedPayload = {
        ...payload,
        ...(stale ? { isStale: true } : {}),
        cacheHash: getRecommendationCacheHash(payload),
    };

    await writeHotCopy(cacheKey, normalizedPayload, ttlSeconds);
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
                logger.error("Recommendation cache delete failed:", error.message);
            }

            deleteMemoryCachedRecommendations(cacheKey);
        }),
    );
    // The stored lists stay readable (no waiting) and are recomputed in the background on next read
    await markStoredListsStale(uniqueIds);
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
