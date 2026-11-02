// Request-level protection that sits in front of every route: rate limits and the cross-site check.
const { rateLimit, ipKeyGenerator } = require("express-rate-limit");
const { config } = require("../config");
const logger = require("../utils/logger");

const FIFTEEN_MINUTES = 15 * 60 * 1000;

// Limits are counted in this process's memory: right for one server instance. Running several
// instances needs a shared store (e.g. rate-limit-redis) so they count together.
const limiter = (options) =>
    rateLimit({
        standardHeaders: "draft-8",
        legacyHeaders: false,
        skip: () => !config.rateLimit.enabled,
        handler: (req, res, next, opts) => {
            logger.warn(`[RATE LIMIT] ${req.method} ${req.originalUrl} from ${req.ip}`);
            res.status(opts.statusCode).json({ message: opts.message, code: "RATE_LIMITED" });
        },
        ...options,
    });

// Every route, per IP
const globalLimiter = limiter({
    windowMs: FIFTEEN_MINUTES,
    limit: config.rateLimit.globalMax,
    message: "Too many requests from this network. Please try again in a few minutes.",
});

// Sign-in, sign-up, codes and password reset, per IP: slows password guessing and code guessing
const authLimiter = limiter({
    windowMs: FIFTEEN_MINUTES,
    limit: config.rateLimit.authMax,
    message: "Too many attempts. Please wait 15 minutes and try again.",
});

// The same routes per email address, whatever the IP: stops guessing one account's code from many
// addresses, and stops anyone flooding an inbox with codes
const perEmailLimiter = limiter({
    windowMs: FIFTEEN_MINUTES,
    limit: config.rateLimit.perEmailMax,
    message: "Too many attempts for this email address. Please wait 15 minutes and try again.",
    keyGenerator: (req) => {
        const email = String(req.body?.email || "")
            .trim()
            .toLowerCase();
        return email ? `email:${email}` : `ip:${ipKeyGenerator(req.ip)}`;
    },
});

// AI routes spend paid model quota: per signed-in browser (cookie) or IP, per minute
const aiLimiter = limiter({
    windowMs: 60 * 1000,
    limit: config.rateLimit.aiPerMinute,
    message: "You're sending AI requests too quickly. Please wait a minute.",
});

const AUTH_PATHS = [
    "/login",
    "/signup",
    "/auth/verify-otp",
    "/auth/forgot-password",
    "/auth/reset-password",
    "/auth/resend-verification",
    "/auth/unblock-request",
    "/auth/refresh",
    "/profile/email/change",
    "/profile/email/confirm",
];
const AI_PATHS = ["/aichat/stream", "/message-ai/conversation", "/generate-ai-expertise"];

const applyRateLimits = (app) => {
    app.use(globalLimiter);
    app.use(AUTH_PATHS, authLimiter);
    app.use(
        ["/login", "/auth/verify-otp", "/auth/forgot-password", "/auth/reset-password", "/auth/resend-verification"],
        perEmailLimiter,
    );
    app.use(AI_PATHS, aiLimiter);
};

const isLocalOrigin = (origin) => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

// Local dev servers on any port are trusted outside production only
const isAllowedOrigin = (origin) =>
    config.frontendOrigins.includes("*") ||
    config.frontendOrigins.includes(origin) ||
    (!config.isProduction && isLocalOrigin(origin));

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// CSRF protection. In production the session cookie is SameSite=None (the API and the site are on
// different domains), so the browser would attach it to a form or fetch from any website. Browsers
// always send an Origin header on such cross-site requests, so a changing request from an origin
// that isn't ours is refused. Requests without Origin come from non-browser clients (curl, the
// test suite, server-to-server), which can't ride on a visitor's cookies.
const requireTrustedOrigin = (req, res, next) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.get("Origin");
    if (!origin || isAllowedOrigin(origin)) return next();
    logger.warn(`[CSRF] Refused ${req.method} ${req.originalUrl} from origin ${origin}`);
    return res.status(403).json({ message: "Request refused: unknown origin.", code: "BAD_ORIGIN" });
};

module.exports = { applyRateLimits, requireTrustedOrigin, isAllowedOrigin };
