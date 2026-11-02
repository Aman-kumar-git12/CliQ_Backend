// Every setting the backend reads from the environment. This is the only file that touches process.env.
require("dotenv").config();

const env = process.env;

// Missing any of these makes the server unusable, so it refuses to start.
const REQUIRED = [
    "DATABASE_URL",
    "JWT_SECRET_KEY",
    "FRONTEND_URL",
    "CLOUD_NAME",
    "CLOUD_KEY",
    "CLOUD_SECRET",
    "SMTP_USER",
    "SMTP_PASS",
    "AGENT_INTERNAL_KEY",
];

const missingVariables = () => REQUIRED.filter((name) => !env[name]);

const parseNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const parsePositiveNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const splitList = (value) =>
    String(value || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);

const nodeEnv = env.NODE_ENV || "development";
const frontendOrigins = splitList(env.FRONTEND_URL || "http://localhost:5173");

const config = {
    nodeEnv,
    isProduction: nodeEnv === "production",
    isDevelopment: env.NODE_ENV === "development",
    logLevel: env.LOG_LEVEL || "info",

    port: Number(env.PORT) || 2004,
    portRetryCount: Number(env.PORT_RETRY_COUNT) || 10,

    // FRONTEND_URL may list several origins separated by commas; the first is the main site
    frontendOrigins,
    frontendUrl: frontendOrigins[0] || "http://localhost:5173",
    emailVerificationUrl: env.EMAIL_VERIFICATION_URL || "",

    jwtSecret: env.JWT_SECRET_KEY,
    // Set while rotating JWT_SECRET_KEY: tokens signed with the old secret stay valid until they expire
    jwtPreviousSecret: env.JWT_SECRET_KEY_PREVIOUS || "",
    // Short-lived access cookie, renewed through the refresh cookie (POST /auth/refresh).
    // A sign-in lasts sessionDays from login, however often it is renewed; then the user logs in again.
    session: {
        accessTtlSeconds: parsePositiveNumber(env.ACCESS_TOKEN_TTL_SECONDS, 15 * 60),
        sessionDays: parsePositiveNumber(env.SESSION_TTL_DAYS, 7),
    },
    // Hops of proxies in front of the server (Render adds one); needed so rate limits see the real client IP
    trustProxy: parseNumber(env.TRUST_PROXY, nodeEnv === "production" ? 1 : 0),
    logFormat: env.LOG_FORMAT || (nodeEnv === "production" ? "json" : "pretty"),
    sentry: {
        dsn: env.SENTRY_DSN || "",
        tracesSampleRate: parseNumber(env.SENTRY_TRACES_SAMPLE_RATE, 0.1),
    },
    rateLimit: {
        // The test suite turns limits off (RATE_LIMIT_ENABLED=false) except in the test that checks them
        enabled: env.RATE_LIMIT_ENABLED !== "false",
        // Every route, per IP per 15 minutes
        globalMax: parsePositiveNumber(env.RATE_LIMIT_GLOBAL_MAX, 1000),
        // Login, signup, OTP and password-reset routes, per IP per 15 minutes
        authMax: parsePositiveNumber(env.RATE_LIMIT_AUTH_MAX, 30),
        // Codes and emails for one address, per 15 minutes, whatever the IP
        perEmailMax: parsePositiveNumber(env.RATE_LIMIT_PER_EMAIL_MAX, 10),
        // AI routes (they spend LLM quota), per user per minute
        aiPerMinute: parsePositiveNumber(env.RATE_LIMIT_AI_PER_MINUTE, 20),
    },
    redisUrl: env.REDIS_URL || "redis://127.0.0.1:6379",

    google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
        redirectUri: env.GOOGLE_REDIRECT_URI,
    },

    cloudinary: {
        cloudName: env.CLOUD_NAME,
        apiKey: env.CLOUD_KEY,
        apiSecret: env.CLOUD_SECRET,
    },

    // Email goes through Brevo's HTTP API; SMTP_PASS holds the Brevo API key
    mail: {
        apiKey: env.SMTP_PASS,
        fromEmail: env.SMTP_FROM || env.SMTP_USER,
    },

    // The Python AI agent (WebsiteAgent); it refuses any call without the shared key
    agent: {
        url: env.LLM_SERVICE_URL || "http://localhost:8000",
        // Drafting an expertise page is one LLM call; past this the user gets a clear error instead of a spinner
        expertiseTimeoutMs: parsePositiveNumber(env.AGENT_EXPERTISE_TIMEOUT_MS, 45000),
        // Background calls (profile embeddings, help-chat history and feedback): nobody waits on them
        backgroundTimeoutMs: parsePositiveNumber(env.AGENT_BACKGROUND_TIMEOUT_MS, 15000),
        // AI help chat: the agent must start answering within this time, and keep sending within it
        chatIdleTimeoutMs: parsePositiveNumber(env.AGENT_CHAT_IDLE_TIMEOUT_MS, 30000),
        // A getter so each call also forwards the current request id (required lazily: the logger needs config first)
        get authHeaders() {
            const { requestId } = require("../utils/requestContext").currentContext();
            return {
                "X-Internal-Key": env.AGENT_INTERNAL_KEY || "",
                ...(requestId ? { "X-Request-Id": requestId } : {}),
            };
        },
    },

    // Off by default: set KEEPALIVE_URL to this API's public address to keep a free Render instance awake
    // (only outside traffic counts). An always-on free instance uses ~744 of the 750 free hours a month.
    keepaliveUrl: env.KEEPALIVE_URL || "",

    search: {
        semanticTimeoutMs: parseNumber(env.SEMANTIC_SEARCH_TIMEOUT_MS, 6000),
        semanticCandidateLimit: parseNumber(env.SEMANTIC_SEARCH_CANDIDATE_LIMIT, 500),
    },

    messageAssistant: {
        replyTimeoutMs: parsePositiveNumber(
            env.MESSAGE_ASSISTANT_REPLY_TIMEOUT_MS || env.MESSAGE_ASSISTANT_TIMEOUT_MS,
            20000,
        ),
        streamTimeoutMs: parsePositiveNumber(
            env.MESSAGE_ASSISTANT_STREAM_TIMEOUT_MS || env.MESSAGE_ASSISTANT_TIMEOUT_MS,
            30000,
        ),
        retryCount: parsePositiveNumber(env.MESSAGE_ASSISTANT_RETRY_COUNT, 2),
        askContextMessages: parsePositiveNumber(env.MESSAGE_ASSISTANT_ASK_CONTEXT_MESSAGES, 15),
        replyContextMessages: parsePositiveNumber(env.MESSAGE_ASSISTANT_REPLY_CONTEXT_MESSAGES, 20),
        historyTurns: parsePositiveNumber(env.MESSAGE_ASSISTANT_HISTORY_TURNS, 12),
        maxInputChars: parsePositiveNumber(env.MESSAGE_ASSISTANT_MAX_INPUT_CHARS, 1200),
    },

    // Smart connections tuning; the recommendation constants clamp these to safe ranges
    smart: {
        maxFeedbackEvents: parseNumber(env.SMART_MAX_FEEDBACK_EVENTS, 160),
        aiMatchTimeoutMs: parseNumber(env.AI_MATCH_TIMEOUT_MS, 30000),
        notPreferredExclusionDays: parseNumber(env.SMART_NOT_PREFERRED_EXCLUSION_DAYS, 14),
        shownExclusionMinutes: parseNumber(env.SMART_SHOWN_EXCLUSION_MINUTES, 60),
        discoverableMinCompleteness: parseNumber(env.SMART_DISCOVERABLE_MIN_COMPLETENESS, 1),
        lowConfidenceScore: parseNumber(env.SMART_LOW_CONFIDENCE_SCORE, 0.5),
        lowProfileQualityScore: parseNumber(env.SMART_LOW_PROFILE_QUALITY_SCORE, 0.42),
        profileQualityWeight: parseNumber(env.SMART_PROFILE_QUALITY_WEIGHT, 0.12),
        feedbackHalfLifeDays: parseNumber(env.SMART_FEEDBACK_HALF_LIFE_DAYS, 45),
        explorationSlots: parseNumber(env.SMART_EXPLORATION_SLOTS, 1),
        explorationNoveltyWeight: parseNumber(env.SMART_EXPLORATION_NOVELTY_WEIGHT, 0.22),
        explorationMinScoreFloor: parseNumber(env.SMART_EXPLORATION_MIN_SCORE_FLOOR, 0.16),
        diversity: {
            clusterPenalty: parseNumber(env.SMART_DIVERSITY_CLUSTER_PENALTY, 0.12),
            profileTypePenalty: parseNumber(env.SMART_DIVERSITY_PROFILE_TYPE_PENALTY, 0.08),
            locationPenalty: parseNumber(env.SMART_DIVERSITY_LOCATION_PENALTY, 0.06),
            backgroundPenalty: parseNumber(env.SMART_DIVERSITY_BACKGROUND_PENALTY, 0.06),
        },
        feedbackWeights: {
            saved: parseNumber(env.SMART_FEEDBACK_WEIGHT_SAVED, 0.75),
            preferred: parseNumber(env.SMART_FEEDBACK_WEIGHT_PREFERRED, 0.95),
            interested: parseNumber(env.SMART_FEEDBACK_WEIGHT_INTERESTED, 1.15),
            ignored: parseNumber(env.SMART_FEEDBACK_WEIGHT_IGNORED, -1.1),
        },
    },
};

module.exports = { config, missingVariables, parseNumber };
