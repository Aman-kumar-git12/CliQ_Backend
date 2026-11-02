// Redis is optional: it holds hot copies (recommendations, AI answers) and presence. When it is down every
// caller falls back (memory, MongoDB), so a call must never wait on it for long.
const { createClient } = require("redis");
const { config } = require("./index");
const logger = require("../utils/logger");

const CONNECT_TIMEOUT_MS = 1000;
// The longest a request waits for a connection attempt before carrying on without Redis
const READY_WAIT_MS = 1500;
// After a failed attempt, callers skip Redis (no waiting at all) for this long, then it is tried again
const RETRY_COOLDOWN_MS = 30 * 1000;
const MAX_RECONNECT_RETRIES = 2;

const redisClient = createClient({
    url: config.redisUrl,
    socket: {
        connectTimeout: CONNECT_TIMEOUT_MS,
        // The default strategy retries forever, and connect() never settles while the server is unreachable.
        // Give up after a couple of quick retries; ensureReady() tries again after the cooldown.
        reconnectStrategy: (retries, cause) =>
            retries >= MAX_RECONNECT_RETRIES ? cause || new Error("Redis unavailable") : 100 * (retries + 1),
    },
});

let connectPromise = null;
let unavailableUntil = 0;
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
    unavailableUntil = 0;
});

const markUnavailable = (err) => {
    unavailableUntil = Date.now() + RETRY_COOLDOWN_MS;
    if (!redisUnavailableLogged) {
        logger.error("Redis unavailable, continuing without Redis cache:", err?.message || err);
        redisUnavailableLogged = true;
    }
    return false;
};

// Resolves true when Redis can be used right now, false otherwise; never waits more than READY_WAIT_MS
const ensureRedisReady = async () => {
    if (redisClient.isReady) return true;
    if (Date.now() < unavailableUntil) return false;
    // Open but not ready: the client is reconnecting by itself, so don't wait for it
    if (redisClient.isOpen) return false;
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
        let timer;
        try {
            const timedOut = new Promise((resolve) => {
                timer = setTimeout(() => resolve(false), READY_WAIT_MS);
                timer.unref?.();
            });
            // A connect() that loses the race keeps running; if it fails later, race has already handled that
            const connected = await Promise.race([redisClient.connect().then(() => true), timedOut]);
            return connected || markUnavailable(new Error(`no connection within ${READY_WAIT_MS}ms`));
        } catch (err) {
            return markUnavailable(err);
        } finally {
            clearTimeout(timer);
            connectPromise = null;
        }
    })();

    return connectPromise;
};

redisClient.ensureReady = ensureRedisReady;

module.exports = redisClient;
