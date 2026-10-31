const { createClient } = require("redis");
const { config } = require("./index");
const logger = require("../utils/logger");

const redisClient = createClient({
    url: config.redisUrl,
});

let connectPromise = null;
let redisUnavailableLogged = false;

redisClient.on("error", (err) => {
    if (!redisUnavailableLogged) {
        logger.info("Redis Client Error", err.message || err);
        redisUnavailableLogged = true;
    }
});
redisClient.on("connect", () => logger.info("Redis Client Connected"));
redisClient.on("ready", () => {
    redisUnavailableLogged = false;
});

const ensureRedisReady = async () => {
    if (redisClient.isReady) {
        return true;
    }

    if (connectPromise) {
        return connectPromise;
    }

    connectPromise = redisClient
        .connect()
        .then(() => true)
        .catch((err) => {
            if (!redisUnavailableLogged) {
                logger.error("Redis unavailable, continuing without Redis cache:", err.message || err);
                redisUnavailableLogged = true;
            }
            return false;
        })
        .finally(() => {
            connectPromise = null;
        });

    return connectPromise;
};

redisClient.ensureReady = ensureRedisReady;

module.exports = redisClient;
