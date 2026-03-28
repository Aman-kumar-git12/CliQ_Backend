const { createClient } = require('redis');

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://127.0.0.1:6379'
});

let connectPromise = null;
let redisUnavailableLogged = false;

redisClient.on('error', (err) => {
    if (!redisUnavailableLogged) {
        console.log('Redis Client Error', err.message || err);
        redisUnavailableLogged = true;
    }
});
redisClient.on('connect', () => console.log('Redis Client Connected'));
redisClient.on('ready', () => {
    redisUnavailableLogged = false;
});

const ensureRedisReady = async () => {
    if (redisClient.isReady) {
        return true;
    }

    if (connectPromise) {
        return connectPromise;
    }

    connectPromise = redisClient.connect()
        .then(() => true)
        .catch((err) => {
            if (!redisUnavailableLogged) {
                console.error('Redis unavailable, continuing without Redis cache:', err.message || err);
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
