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

    // The Python AI agent (WebsiteAgent)
    agent: {
        url: env.LLM_SERVICE_URL || "http://localhost:8000",
        internalKey: env.AGENT_INTERNAL_KEY || "",
    },

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
