const { config, parseNumber } = require("../../config");

const MAX_FEEDBACK_EVENTS = Math.max(40, Math.round(config.smart.maxFeedbackEvents));
const SMART_RECOMMENDATION_BATCH_SIZE = 18;
const SMART_RECOMMENDATION_RESPONSE_SIZE = 10;
const SMART_RECOMMENDATION_CACHE_TTL_SECONDS = 180;
const AI_MATCH_TIMEOUT_MS = Math.max(2500, Math.round(config.smart.aiMatchTimeoutMs));
const NOT_PREFERRED_EXCLUSION_DAYS = Math.max(3, Math.round(config.smart.notPreferredExclusionDays));
const SHOWN_EXCLUSION_MINUTES = Math.max(1, Math.round(config.smart.shownExclusionMinutes));

const RECOMMENDATION_CONFIG = {
    minDiscoverableCompleteness: Math.max(1, Math.round(config.smart.discoverableMinCompleteness)),
    minimumMatchScore: 0.0,
    lowConfidenceScore: config.smart.lowConfidenceScore,
    lowProfileQualityScore: config.smart.lowProfileQualityScore,
    profileQualityWeight: config.smart.profileQualityWeight,
    feedbackHalfLifeDays: Math.max(7, config.smart.feedbackHalfLifeDays),
    explorationSlots: Math.max(1, Math.round(config.smart.explorationSlots)),
    explorationNoveltyWeight: config.smart.explorationNoveltyWeight,
    explorationMinScoreFloor: config.smart.explorationMinScoreFloor,
    diversity: {
        clusterPenalty: config.smart.diversity.clusterPenalty,
        profileTypePenalty: config.smart.diversity.profileTypePenalty,
        locationPenalty: config.smart.diversity.locationPenalty,
        backgroundPenalty: config.smart.diversity.backgroundPenalty,
    },
    feedbackWeights: {
        saved: config.smart.feedbackWeights.saved,
        preferred: config.smart.feedbackWeights.preferred,
        interested: config.smart.feedbackWeights.interested,
        ignored: config.smart.feedbackWeights.ignored,
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

const PLACEHOLDER_VALUES = new Set(["", "****", "professional seeker", "n/a", "na", "null", "undefined"]);

// Empty profile fields are stored as runs of asterisks ("****" from the expertise form, "*******" from signup)
const isPlaceholderText = (value) => {
    const normalized = String(value ?? "")
        .trim()
        .toLowerCase();
    return PLACEHOLDER_VALUES.has(normalized) || /^\*+$/.test(normalized);
};

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
    isPlaceholderText,
};
