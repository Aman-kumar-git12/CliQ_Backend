const { RECOMMENDATION_CONFIG } = require("./constants");
const { normalizeText, normalizeTerms } = require("./coreUtils");
const { buildProfileSignals } = require("./profileSignals");
const {
    getClusterKey,
    detectProfileType,
    detectExperienceLevel,
    detectLocationBucket,
} = require("./classification");

const createWeightedMap = () => new Map();

const addWeightedTerms = (map, items = [], weight = 0) => {
    items.forEach((item) => {
        const key = normalizeText(item).toLowerCase();
        if (!key) return;
        map.set(key, (map.get(key) || 0) + weight);
    });
};

const getFeedbackRecencyMultiplier = (createdAt) => {
    if (!createdAt) return 1;
    const ageMs = Math.max(0, Date.now() - new Date(createdAt).getTime());
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    return Math.pow(0.5, ageDays / RECOMMENDATION_CONFIG.feedbackHalfLifeDays);
};

const isWithinRecentDays = (date, days) => {
    if (!date) return false;
    const ageMs = Date.now() - new Date(date).getTime();
    return ageMs <= days * 24 * 60 * 60 * 1000;
};

const buildFeedbackProfile = (events = [], candidateMap = new Map()) => {
    const feedback = {
        skills: createWeightedMap(),
        interests: createWeightedMap(),
        tokens: createWeightedMap(),
        clusters: createWeightedMap(),
        profileTypes: createWeightedMap(),
        experienceLevels: createWeightedMap(),
        locations: createWeightedMap(),
        totalSignals: 0,
    };

    events.forEach((event) => {
        const candidate = candidateMap.get(event.candidateUserId);
        if (!candidate) return;

        const baseWeight = RECOMMENDATION_CONFIG.feedbackWeights[event.action] || 0;
        const weight = baseWeight * getFeedbackRecencyMultiplier(event.createdAt);
        if (weight === 0) return;

        const signals = buildProfileSignals(candidate.expertise || {});
        const feedbackReasonTerms = normalizeTerms([
            event?.metadata?.reason,
            event?.metadata?.reasonLabel,
            event?.metadata?.preferenceReason,
            event?.metadata?.ignoreReason,
            ...(Array.isArray(event?.metadata?.reasons) ? event.metadata.reasons : []),
            ...(Array.isArray(event?.metadata?.feedbackTags) ? event.metadata.feedbackTags : []),
        ]);

        addWeightedTerms(feedback.skills, signals.skills, weight * 0.4);
        addWeightedTerms(feedback.interests, signals.interests, weight * 0.28);
        addWeightedTerms(feedback.tokens, [...signals.tokens, ...feedbackReasonTerms], weight * 0.12);
        addWeightedTerms(feedback.clusters, [getClusterKey(signals)], weight * 0.32);
        addWeightedTerms(feedback.profileTypes, [detectProfileType(signals)], weight * 0.2);
        addWeightedTerms(feedback.experienceLevels, [detectExperienceLevel(candidate.expertise || {}, signals)], weight * 0.16);
        addWeightedTerms(feedback.locations, [detectLocationBucket(candidate.expertise || {}, signals)], weight * 0.12);
        feedback.totalSignals += 1;
    });

    return feedback;
};

const getTopWeightedTerms = (map, direction = "positive", limit = 6) =>
    [...map.entries()]
        .filter(([, weight]) => (direction === "positive" ? weight > 0 : weight < 0))
        .sort((left, right) =>
            direction === "positive"
                ? right[1] - left[1]
                : left[1] - right[1]
        )
        .slice(0, limit)
        .map(([term]) => term);

module.exports = {
    createWeightedMap,
    addWeightedTerms,
    getFeedbackRecencyMultiplier,
    isWithinRecentDays,
    buildFeedbackProfile,
    getTopWeightedTerms,
};
