// Per-request context (request id, user id) that follows async code without being passed around,
// so every log line and every call to the AI agent can carry the id of the request that caused it.
const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");

const storage = new AsyncLocalStorage();

// An id from the client or a proxy is reused only if it looks like an id, never as raw log input
const VALID_ID = /^[A-Za-z0-9._-]{8,64}$/;

const requestId = (req, res, next) => {
    const incoming = req.get("X-Request-Id");
    const id = incoming && VALID_ID.test(incoming) ? incoming : crypto.randomUUID();
    req.id = id;
    res.setHeader("X-Request-Id", id);
    storage.run({ requestId: id }, next);
};

const currentContext = () => storage.getStore() || {};

module.exports = { requestId, currentContext };
