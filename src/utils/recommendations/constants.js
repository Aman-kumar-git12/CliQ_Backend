const parseNumber = (value, fallback) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
};

const MAX_FEEDBACK_EVENTS = Math.max(40, Math.round(parseNumber(process.env.SMART_MAX_FEEDBACK_EVENTS, 160)));
const SMART_RECOMMENDATION_BATCH_SIZE = 18;
const SMART_RECOMMENDATION_RESPONSE_SIZE = 5;
const SMART_RECOMMENDATION_CACHE_TTL_SECONDS = 180;
const AI_MATCH_TIMEOUT_MS = 2500;
const NOT_PREFERRED_EXCLUSION_DAYS = Math.max(3, Math.round(parseNumber(process.env.SMART_NOT_PREFERRED_EXCLUSION_DAYS, 14)));
const SHOWN_EXCLUSION_MINUTES = Math.max(1, Math.round(parseNumber(process.env.SMART_SHOWN_EXCLUSION_MINUTES, 60)));

const RECOMMENDATION_CONFIG = {
    minDiscoverableCompleteness: Math.max(1, Math.round(parseNumber(process.env.SMART_DISCOVERABLE_MIN_COMPLETENESS, 1))),
    minimumMatchScore: parseNumber(process.env.SMART_MIN_MATCH_SCORE, 0.34),
    lowConfidenceScore: parseNumber(process.env.SMART_LOW_CONFIDENCE_SCORE, 0.5),
    lowProfileQualityScore: parseNumber(process.env.SMART_LOW_PROFILE_QUALITY_SCORE, 0.42),
    profileQualityWeight: parseNumber(process.env.SMART_PROFILE_QUALITY_WEIGHT, 0.12),
    feedbackHalfLifeDays: Math.max(7, parseNumber(process.env.SMART_FEEDBACK_HALF_LIFE_DAYS, 45)),
    explorationSlots: Math.max(1, Math.round(parseNumber(process.env.SMART_EXPLORATION_SLOTS, 1))),
    explorationNoveltyWeight: parseNumber(process.env.SMART_EXPLORATION_NOVELTY_WEIGHT, 0.22),
    explorationMinScoreFloor: parseNumber(process.env.SMART_EXPLORATION_MIN_SCORE_FLOOR, 0.16),
    diversity: {
        clusterPenalty: parseNumber(process.env.SMART_DIVERSITY_CLUSTER_PENALTY, 0.12),
        profileTypePenalty: parseNumber(process.env.SMART_DIVERSITY_PROFILE_TYPE_PENALTY, 0.08),
        locationPenalty: parseNumber(process.env.SMART_DIVERSITY_LOCATION_PENALTY, 0.06),
        backgroundPenalty: parseNumber(process.env.SMART_DIVERSITY_BACKGROUND_PENALTY, 0.06),
    },
    feedbackWeights: {
        saved: parseNumber(process.env.SMART_FEEDBACK_WEIGHT_SAVED, 0.75),
        preferred: parseNumber(process.env.SMART_FEEDBACK_WEIGHT_PREFERRED, 0.95),
        interested: parseNumber(process.env.SMART_FEEDBACK_WEIGHT_INTERESTED, 1.15),
        ignored: parseNumber(process.env.SMART_FEEDBACK_WEIGHT_IGNORED, -1.1),
    },
};

const SMART_RECOMMENDATION_SOURCES = ["smart_connections", "saved_recommendations"];
const RECOMMENDATION_FEEDBACK_ACTIONS = ["shown", "saved", "interested", "ignored"];
const RECOMMENDATION_PREFERENCE_ACTIVE_STATUSES = ["preferred", "not_preferred"];
const RECOMMENDATION_PREVIEW_SELECT = {
    id: true,
    firstname: true,
    lastname: true,
    expertise: true,
    imageUrl: true,
    email: true,
    age: true,
};

const PLACEHOLDER_VALUES = new Set([
    "",
    "****",
    "professional seeker",
    "n/a",
    "na",
    "null",
    "undefined",
]);

const LOG_FILE = "/tmp/debug_smart_users.log";

module.exports = {
    parseNumber,
    MAX_FEEDBACK_EVENTS,
    SMART_RECOMMENDATION_BATCH_SIZE,
    SMART_RECOMMENDATION_RESPONSE_SIZE,
    SMART_RECOMMENDATION_CACHE_TTL_SECONDS,
    AI_MATCH_TIMEOUT_MS,
    NOT_PREFERRED_EXCLUSION_DAYS,
    SHOWN_EXCLUSION_MINUTES,
    RECOMMENDATION_CONFIG,
    SMART_RECOMMENDATION_SOURCES,
    RECOMMENDATION_FEEDBACK_ACTIONS,
    RECOMMENDATION_PREFERENCE_ACTIVE_STATUSES,
    RECOMMENDATION_PREVIEW_SELECT,
    PLACEHOLDER_VALUES,
    LOG_FILE,
};
