const { createHash } = require("crypto");
const { prisma } = require("../../prisma/prismaClient");
const fs = require('fs');

const logFile = '/tmp/debug_smart_users.log';
const axios = require("axios");
const redisClient = require("../config/redisClient");

const PLACEHOLDER_VALUES = new Set([
    "",
    "****",
    "professional seeker",
    "n/a",
    "na",
    "null",
    "undefined",
]);
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

const normalizeText = (value) => {
    if (value === null || value === undefined) return "";
    return String(value).trim();
};

const isMeaningfulText = (value) => {
    const normalized = normalizeText(value);
    if (!normalized) return false;
    return !PLACEHOLDER_VALUES.has(normalized.toLowerCase());
};

const normalizeTerms = (value) => {
    const rawItems = Array.isArray(value)
        ? value
        : normalizeText(value).split(/[,|\n;/]+/);

    const deduped = new Map();
    rawItems.forEach((item) => {
        const text = normalizeText(item);
        if (!isMeaningfulText(text)) return;
        const key = text.toLowerCase();
        if (!deduped.has(key)) {
            deduped.set(key, text);
        }
    });

    return Array.from(deduped.values());
};

const getNestedObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

const getExplicitPreferenceValue = (expertise = {}, ...keys) => {
    const containers = [
        getNestedObject(expertise),
        getNestedObject(expertise.preferences),
        getNestedObject(expertise.matchPreferences),
        getNestedObject(expertise.connectionPreferences),
    ];

    for (const key of keys) {
        for (const container of containers) {
            if (container[key] !== undefined && container[key] !== null) {
                return container[key];
            }
        }
    }

    return undefined;
};

const summarizeList = (items = [], prefix = "", limit = 6) => {
    const normalized = normalizeTerms(items).slice(0, limit);
    if (normalized.length === 0) return "";
    return `${prefix}${normalized.join(", ")}`;
};

const tokenize = (values = []) => {
    const tokens = new Set();
    values.forEach((value) => {
        const text = normalizeText(value).toLowerCase();
        text
            .split(/[^a-z0-9+#.]+/i)
            .map((token) => token.trim())
            .filter((token) => token.length >= 3)
            .forEach((token) => tokens.add(token));
    });
    return tokens;
};

const buildExplicitPreferenceProfile = (expertise = {}) => {
    const lookingFor = normalizeTerms(getExplicitPreferenceValue(expertise, "lookingFor", "openTo", "connectionGoals"));
    const preferredRoles = normalizeTerms(getExplicitPreferenceValue(expertise, "preferredRoles", "roles", "desiredRoles"));
    const preferredIndustries = normalizeTerms(getExplicitPreferenceValue(expertise, "preferredIndustries", "industries", "desiredIndustries"));
    const preferredLocations = normalizeTerms(getExplicitPreferenceValue(expertise, "preferredLocations", "locations", "targetLocations"));
    const preferredLanguages = normalizeTerms(getExplicitPreferenceValue(expertise, "preferredLanguages", "languages"));
    const preferredExperienceLevels = normalizeTerms(getExplicitPreferenceValue(expertise, "preferredExperienceLevels", "experienceLevels"));
    const dealBreakers = normalizeTerms(getExplicitPreferenceValue(expertise, "dealBreakers", "avoid", "avoidTypes"));

    const summaryParts = [
        summarizeList(lookingFor, "Looking for: "),
        summarizeList(preferredRoles, "Preferred roles: "),
        summarizeList(preferredIndustries, "Preferred industries: "),
        summarizeList(preferredLocations, "Preferred locations: "),
        summarizeList(preferredLanguages, "Preferred languages: "),
        summarizeList(preferredExperienceLevels, "Preferred experience levels: "),
        summarizeList(dealBreakers, "Avoid: "),
    ].filter(Boolean);

    return {
        lookingFor,
        preferredRoles,
        preferredIndustries,
        preferredLocations,
        preferredLanguages,
        preferredExperienceLevels,
        dealBreakers,
        summary: summaryParts.join(". "),
        hasSignal: summaryParts.length > 0,
    };
};

const buildProfileSignals = (expertise = {}) => {
    const skills = normalizeTerms(expertise.skills);
    const interests = normalizeTerms(expertise.interests);
    const headline = isMeaningfulText(expertise.description)
        ? normalizeText(expertise.description)
        : isMeaningfulText(expertise.aboutYou)
            ? normalizeText(expertise.aboutYou)
            : isMeaningfulText(expertise.experience)
                ? normalizeText(expertise.experience)
                : "";

    const textFields = [
        expertise.description,
        expertise.aboutYou,
        expertise.experience,
        expertise.projects,
        expertise.achievements,
        expertise.historySummary,
        expertise.preferenceSummary,
        expertise.explicitPreferenceSummary,
        expertise.connectionHeadlines,
        expertise.likedThemes,
        expertise.details?.address,
        expertise.role,
        expertise.roles,
        expertise.industry,
        expertise.industries,
        expertise.languages,
        expertise.education,
        expertise.goals,
        expertise.lookingFor,
        expertise.openTo,
        expertise.availability,
        expertise.activitySummary,
        expertise.responsivenessSummary,
        expertise.outcomeSummary,
    ].filter(isMeaningfulText);

    return {
        skills,
        interests,
        headline,
        textFields,
        tokens: tokenize(textFields),
        completeness: [headline, ...skills, ...interests, ...textFields].length,
    };
};

const detectExperienceLevel = (expertise = {}, signals = {}) => {
    const source = [
        normalizeText(expertise.experienceLevel),
        normalizeText(expertise.yearsOfExperience),
        normalizeText(expertise.experience),
        signals.headline,
        ...(signals.textFields || []),
    ].join(" ").toLowerCase();

    if (!source) return "experience:unknown";
    if (source.includes("student") || source.includes("intern")) return "experience:student";
    if (source.includes("senior") || source.includes("lead") || source.includes("principal") || source.includes("10+") || source.includes("8+")) return "experience:senior";
    if (source.includes("junior") || source.includes("entry")) return "experience:junior";
    if (source.includes("mid") || source.includes("3+") || source.includes("4+")) return "experience:mid";
    return "experience:general";
};

const getProfileQualityScore = (expertise = {}) => {
    const signals = buildProfileSignals(expertise);
    const qualityScore = Math.max(0, Math.min(1,
        (signals.headline ? 0.32 : 0) +
        Math.min(signals.skills.length, 5) * 0.09 +
        Math.min(signals.interests.length, 4) * 0.06 +
        Math.min(signals.textFields.length, 4) * 0.08
    ));
    return Number(qualityScore.toFixed(4));
};

const getProfileQualityLabel = (qualityScore = 0) => {
    if (qualityScore >= 0.82) return "High-signal profile";
    if (qualityScore >= 0.62) return "Strong profile";
    if (qualityScore >= 0.42) return "Moderate profile";
    return "Limited profile signal";
};

const isDiscoverableProfile = (expertise = {}) => {
    const signals = buildProfileSignals(expertise);
    const hasCoreSignal =
        Boolean(signals.headline) ||
        signals.skills.length > 0 ||
        signals.interests.length > 0 ||
        signals.textFields.length > 0;
    return hasCoreSignal && signals.completeness >= RECOMMENDATION_CONFIG.minDiscoverableCompleteness;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const recommendationCacheMemory = new Map();

const getRecommendationCacheKey = (userId) => `smart_recommendations:v3:${userId}`;

const getRecommendationCachePayload = (users = [], strategy = "fallback") => ({
    users,
    strategy,
    cachedAt: new Date().toISOString(),
});

const getRecommendationCacheHash = (payload = {}) =>
    createHash("sha1").update(JSON.stringify(payload)).digest("hex");

const getMemoryCachedRecommendations = (key) => {
    const entry = recommendationCacheMemory.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
        recommendationCacheMemory.delete(key);
        return null;
    }
    return entry.value;
};

const setMemoryCachedRecommendations = (key, value, ttlSeconds) => {
    recommendationCacheMemory.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
    });
};

const deleteMemoryCachedRecommendations = (key) => {
    recommendationCacheMemory.delete(key);
};

const getCachedRecommendationBatch = async (userId) => {
    const cacheKey = getRecommendationCacheKey(userId);

    try {
        if (redisClient?.isReady) {
            const raw = await redisClient.get(cacheKey);
            if (raw) {
                console.log(`[Cache] Hit for user ${userId}`);
                return JSON.parse(raw);
            }
        }
    } catch (error) {
        console.error(`[Cache] Read failed for user ${userId}:`, error.message);
    }

    console.log(`[Cache] Miss for user ${userId}, falling back to memory`);
    return getMemoryCachedRecommendations(cacheKey);
};

const setCachedRecommendationBatch = async (userId, payload, ttlSeconds = SMART_RECOMMENDATION_CACHE_TTL_SECONDS) => {
    const cacheKey = getRecommendationCacheKey(userId);
    const normalizedPayload = {
        ...payload,
        cacheHash: getRecommendationCacheHash(payload),
    };

    try {
        if (redisClient?.isReady) {
            await redisClient.set(cacheKey, JSON.stringify(normalizedPayload), { EX: ttlSeconds });
            return;
        }
    } catch (error) {
        console.error("Recommendation cache write failed:", error.message);
    }

    setMemoryCachedRecommendations(cacheKey, normalizedPayload, ttlSeconds);
};

const invalidateRecommendationCache = async (...userIds) => {
    const uniqueIds = [...new Set(userIds.flat().filter(Boolean))];
    if (uniqueIds.length === 0) return;

    await Promise.all(
        uniqueIds.map(async (userId) => {
            const cacheKey = getRecommendationCacheKey(userId);

            try {
                if (redisClient?.isReady) {
                    await redisClient.del(cacheKey);
                }
            } catch (error) {
                console.error("Recommendation cache delete failed:", error.message);
            }

            deleteMemoryCachedRecommendations(cacheKey);
        })
    );
};

const detectProfileType = (signals = {}) => {
    const text = [signals.headline, ...(signals.textFields || [])].join(" ").toLowerCase();
    if (text.includes("designer") || text.includes("ui/ux") || text.includes("ux ")) return "design";
    if (text.includes("manager") || text.includes("lead") || text.includes("strategy")) return "leadership";
    if (text.includes("data") || text.includes("analyst") || text.includes("analytics")) return "data";
    if (text.includes("devops") || text.includes("platform") || text.includes("cloud")) return "platform";
    if (text.includes("developer") || text.includes("engineer") || text.includes("software")) return "engineering";
    if ((signals.skills || []).length > 0) return signals.skills[0].toLowerCase();
    if ((signals.interests || []).length > 0) return signals.interests[0].toLowerCase();
    return "generalist";
};

const detectLocationBucket = (expertise = {}, signals = {}) => {
    const rawLocation = normalizeText(expertise?.details?.address || signals.textFields?.[0] || "");
    if (!rawLocation) return "location:unknown";
    const parts = rawLocation
        .split(/[,/|-]+/)
        .map((part) => normalizeText(part).toLowerCase())
        .filter(Boolean);
    if (parts.length === 0) return "location:unknown";
    return `location:${parts[parts.length - 1]}`;
};

const detectBackgroundKey = (signals = {}) => {
    const source = [signals.headline, ...(signals.textFields || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    if (!source) return "background:general";
    if (source.includes("startup") || source.includes("founder")) return "background:startup";
    if (source.includes("enterprise") || source.includes("consult")) return "background:enterprise";
    if (source.includes("student") || source.includes("college") || source.includes("university")) return "background:student";
    if (source.includes("freelance") || source.includes("agency")) return "background:freelance";
    if (source.includes("open source") || source.includes("community")) return "background:community";
    const token = [...(signals.tokens || [])][0];
    return token ? `background:${token}` : "background:general";
};

const getClusterKey = (signals = {}) => {
    if ((signals.skills || []).length > 0) return `skill:${signals.skills[0].toLowerCase()}`;
    if ((signals.interests || []).length > 0) return `interest:${signals.interests[0].toLowerCase()}`;
    if (signals.headline) return `headline:${signals.headline.toLowerCase().split(/\s+/).slice(0, 2).join("-")}`;
    return "cluster:general";
};

const buildCandidateActivitySummary = (metrics = {}) => {
    const parts = [];
    if (typeof metrics.acceptanceRate === "number") {
        parts.push(`acceptance rate ${(metrics.acceptanceRate * 100).toFixed(0)}%`);
    }
    if (typeof metrics.responseRate === "number") {
        parts.push(`response rate ${(metrics.responseRate * 100).toFixed(0)}%`);
    }
    if (typeof metrics.activityLevel === "string" && metrics.activityLevel) {
        parts.push(`${metrics.activityLevel} activity`);
    }
    if (typeof metrics.activeConversationCount === "number" && metrics.activeConversationCount > 0) {
        parts.push(`${metrics.activeConversationCount} active conversations`);
    }
    return parts.join(", ");
};

const getActivityRecencyScore = (updatedAt) => {
    if (!updatedAt) return 0.12;
    const ageDays = (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24);
    if (ageDays <= 3) return 1;
    if (ageDays <= 10) return 0.82;
    if (ageDays <= 21) return 0.62;
    if (ageDays <= 45) return 0.4;
    return 0.18;
};

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

const buildHistoryProfile = (userExpertise = {}, feedbackProfile = null, acceptedConnections = []) => {
    const explicitPreferenceProfile = buildExplicitPreferenceProfile(userExpertise);
    const acceptedSignals = acceptedConnections.map((candidate) => buildProfileSignals(candidate.expertise || {}));
    const acceptedHeadlines = acceptedSignals
        .map((signals) => signals.headline)
        .filter(Boolean)
        .slice(0, 6);
    const acceptedSkills = normalizeTerms(acceptedSignals.flatMap((signals) => signals.skills).slice(0, 24));
    const acceptedInterests = normalizeTerms(acceptedSignals.flatMap((signals) => signals.interests).slice(0, 24));

    const likedSkills = feedbackProfile ? getTopWeightedTerms(feedbackProfile.skills, "positive", 8) : [];
    const likedInterests = feedbackProfile ? getTopWeightedTerms(feedbackProfile.interests, "positive", 6) : [];
    const likedThemes = feedbackProfile ? getTopWeightedTerms(feedbackProfile.tokens, "positive", 8) : [];
    const avoidedSkills = feedbackProfile ? getTopWeightedTerms(feedbackProfile.skills, "negative", 6) : [];
    const avoidedInterests = feedbackProfile ? getTopWeightedTerms(feedbackProfile.interests, "negative", 5) : [];
    const avoidedThemes = feedbackProfile ? getTopWeightedTerms(feedbackProfile.tokens, "negative", 6) : [];
    const likedExperienceLevels = feedbackProfile ? getTopWeightedTerms(feedbackProfile.experienceLevels, "positive", 3) : [];
    const avoidedExperienceLevels = feedbackProfile ? getTopWeightedTerms(feedbackProfile.experienceLevels, "negative", 3) : [];
    const likedLocations = feedbackProfile ? getTopWeightedTerms(feedbackProfile.locations, "positive", 4) : [];
    const avoidedLocations = feedbackProfile ? getTopWeightedTerms(feedbackProfile.locations, "negative", 4) : [];

    const positiveSummary = [
        acceptedHeadlines.length > 0 ? `Connected profiles: ${acceptedHeadlines.join(" | ")}` : "",
        acceptedSkills.length > 0 ? `Usually connects with skills like ${acceptedSkills.slice(0, 8).join(", ")}` : "",
        likedSkills.length > 0 ? `Often likes people with ${likedSkills.join(", ")}` : "",
        likedInterests.length > 0 ? `Often engages with interests around ${likedInterests.join(", ")}` : "",
        likedThemes.length > 0 ? `Positive themes: ${likedThemes.join(", ")}` : "",
        likedExperienceLevels.length > 0 ? `Positive experience fit: ${likedExperienceLevels.join(", ")}` : "",
        likedLocations.length > 0 ? `Positive locations: ${likedLocations.join(", ")}` : "",
        explicitPreferenceProfile.summary || "",
    ].filter(Boolean).join(". ");

    const negativeSummary = [
        avoidedSkills.length > 0 ? `Often skips skills like ${avoidedSkills.join(", ")}` : "",
        avoidedInterests.length > 0 ? `Often skips interests around ${avoidedInterests.join(", ")}` : "",
        avoidedThemes.length > 0 ? `Avoided themes: ${avoidedThemes.join(", ")}` : "",
        avoidedExperienceLevels.length > 0 ? `Often skips experience levels like ${avoidedExperienceLevels.join(", ")}` : "",
        avoidedLocations.length > 0 ? `Often skips locations like ${avoidedLocations.join(", ")}` : "",
        explicitPreferenceProfile.dealBreakers.length > 0 ? `Explicit deal breakers: ${explicitPreferenceProfile.dealBreakers.join(", ")}` : "",
    ].filter(Boolean).join(". ");

    return {
        explicitPreferenceProfile,
        acceptedHeadlines,
        acceptedSkills,
        acceptedInterests,
        likedSkills,
        likedInterests,
        likedThemes,
        likedExperienceLevels,
        likedLocations,
        avoidedSkills,
        avoidedInterests,
        avoidedThemes,
        avoidedExperienceLevels,
        avoidedLocations,
        positiveSummary,
        negativeSummary,
        hasHistorySignal: Boolean(positiveSummary || negativeSummary),
        baseProfileCompleteness: buildProfileSignals(userExpertise).completeness,
    };
};

const buildCompositeMatchingProfile = (userExpertise = {}, historyProfile = null) => {
    if (!historyProfile) return userExpertise || {};

    const explicitPreferenceProfile = historyProfile.explicitPreferenceProfile || buildExplicitPreferenceProfile(userExpertise);

    const mergedSkills = normalizeTerms([
        ...(Array.isArray(userExpertise.skills) ? userExpertise.skills : normalizeTerms(userExpertise.skills)),
        ...historyProfile.acceptedSkills,
        ...historyProfile.likedSkills,
    ]);
    const mergedInterests = normalizeTerms([
        ...normalizeTerms(userExpertise.interests),
        ...historyProfile.acceptedInterests,
        ...historyProfile.likedInterests,
    ]);

    return {
        ...(userExpertise || {}),
        skills: mergedSkills,
        interests: mergedInterests,
        historySummary: historyProfile.positiveSummary,
        preferenceSummary: historyProfile.positiveSummary,
        explicitPreferenceSummary: explicitPreferenceProfile.summary,
        connectionHeadlines: historyProfile.acceptedHeadlines,
        likedThemes: historyProfile.likedThemes,
        avoidedThemes: historyProfile.avoidedThemes,
        lookingFor: explicitPreferenceProfile.lookingFor,
        preferredRoles: explicitPreferenceProfile.preferredRoles,
        preferredIndustries: explicitPreferenceProfile.preferredIndustries,
        preferredLocations: explicitPreferenceProfile.preferredLocations,
        preferredLanguages: explicitPreferenceProfile.preferredLanguages,
        preferredExperienceLevels: explicitPreferenceProfile.preferredExperienceLevels,
        dealBreakers: explicitPreferenceProfile.dealBreakers,
    };
};

const getWeightedSum = (map, items = []) =>
    items.reduce((sum, item) => sum + (map.get(normalizeText(item).toLowerCase()) || 0), 0);

const applyFeedbackToRankings = (rankings = [], candidateMap = new Map(), feedbackProfile = null) => {
    if (!feedbackProfile || feedbackProfile.totalSignals === 0) {
        return rankings;
    }

    return rankings
        .map((ranking) => {
            const candidate = candidateMap.get(ranking.id);
            if (!candidate) return ranking;

            const signals = buildProfileSignals(candidate.expertise || {});
            const clusterKey = getClusterKey(signals);
            const profileType = detectProfileType(signals);

            const feedbackDeltaRaw =
                getWeightedSum(feedbackProfile.skills, signals.skills) +
                getWeightedSum(feedbackProfile.interests, signals.interests) +
                getWeightedSum(feedbackProfile.tokens, [...signals.tokens]) +
                getWeightedSum(feedbackProfile.clusters, [clusterKey]) +
                getWeightedSum(feedbackProfile.profileTypes, [profileType]);

            const feedbackDelta = clamp(feedbackDeltaRaw / Math.max(feedbackProfile.totalSignals, 1), -0.18, 0.18);
            const adjustedScore = clamp((ranking.score || 0) + feedbackDelta, 0, 0.99);

            const reasons = [...(ranking.reasons || [])];
            if (feedbackDelta >= 0.08) {
                reasons.push("Aligned with profiles you usually like");
            } else if (feedbackDelta <= -0.08) {
                reasons.push("Tempered by profiles you often skip");
            }

            return {
                ...ranking,
                score: Number(adjustedScore.toFixed(4)),
                reasons: reasons.slice(0, 3),
            };
        })
        .sort((left, right) => right.score - left.score);
};

const selectBalancedRankings = (rankings = [], candidateMap = new Map(), limit = 5) => {
    const remaining = [...rankings];
    const selected = [];
    const clusterCounts = new Map();
    const profileTypeCounts = new Map();
    const locationCounts = new Map();
    const backgroundCounts = new Map();

    const getCandidateSignature = (candidate) => {
        const signals = buildProfileSignals(candidate.expertise || {});
        return {
            signals,
            clusterKey: getClusterKey(signals),
            profileType: detectProfileType(signals),
            locationBucket: detectLocationBucket(candidate.expertise || {}, signals),
            backgroundKey: detectBackgroundKey(signals),
        };
    };

    const getDiversityPenalty = (signature) =>
        (clusterCounts.get(signature.clusterKey) || 0) * RECOMMENDATION_CONFIG.diversity.clusterPenalty +
        (profileTypeCounts.get(signature.profileType) || 0) * RECOMMENDATION_CONFIG.diversity.profileTypePenalty +
        (locationCounts.get(signature.locationBucket) || 0) * RECOMMENDATION_CONFIG.diversity.locationPenalty +
        (backgroundCounts.get(signature.backgroundKey) || 0) * RECOMMENDATION_CONFIG.diversity.backgroundPenalty;

    const commitSelection = (ranking, signature, selectionMode) => {
        clusterCounts.set(signature.clusterKey, (clusterCounts.get(signature.clusterKey) || 0) + 1);
        profileTypeCounts.set(signature.profileType, (profileTypeCounts.get(signature.profileType) || 0) + 1);
        locationCounts.set(signature.locationBucket, (locationCounts.get(signature.locationBucket) || 0) + 1);
        backgroundCounts.set(signature.backgroundKey, (backgroundCounts.get(signature.backgroundKey) || 0) + 1);

        const reasons = [...(ranking.reasons || [])];
        if (selectionMode === "explore") {
            reasons.push("Exploration pick to broaden your network");
        }

        selected.push({
            ...ranking,
            selectionMode,
            reasons: reasons.slice(0, 3),
            diversity: {
                clusterKey: signature.clusterKey,
                profileType: signature.profileType,
                locationBucket: signature.locationBucket,
                backgroundKey: signature.backgroundKey,
            },
        });
    };

    const exploitationSlots = Math.max(1, limit - Math.min(RECOMMENDATION_CONFIG.explorationSlots, Math.max(limit - 1, 0)));

    while (remaining.length > 0 && selected.length < exploitationSlots) {
        let bestIndex = 0;
        let bestScore = Number.NEGATIVE_INFINITY;
        let bestSignature = null;

        remaining.forEach((ranking, index) => {
            const candidate = candidateMap.get(ranking.id);
            if (!candidate) return;

            const signature = getCandidateSignature(candidate);
            const adjustedScore = (ranking.score || 0) - getDiversityPenalty(signature);
            if (adjustedScore > bestScore) {
                bestScore = adjustedScore;
                bestIndex = index;
                bestSignature = signature;
            }
        });

        const [picked] = remaining.splice(bestIndex, 1);
        if (!picked || !bestSignature) break;
        commitSelection(picked, bestSignature, "exploit");
    }

    while (remaining.length > 0 && selected.length < limit) {
        let bestIndex = 0;
        let bestScore = Number.NEGATIVE_INFINITY;
        let bestSignature = null;

        remaining.forEach((ranking, index) => {
            const candidate = candidateMap.get(ranking.id);
            if (!candidate) return;

            const signature = getCandidateSignature(candidate);
            const noveltyBoost =
                ((clusterCounts.get(signature.clusterKey) || 0) === 0 ? 1 : 0) * RECOMMENDATION_CONFIG.explorationNoveltyWeight +
                ((profileTypeCounts.get(signature.profileType) || 0) === 0 ? 1 : 0) * (RECOMMENDATION_CONFIG.explorationNoveltyWeight * 0.8) +
                ((locationCounts.get(signature.locationBucket) || 0) === 0 ? 1 : 0) * (RECOMMENDATION_CONFIG.explorationNoveltyWeight * 0.55) +
                ((backgroundCounts.get(signature.backgroundKey) || 0) === 0 ? 1 : 0) * (RECOMMENDATION_CONFIG.explorationNoveltyWeight * 0.55);

            const explorationScore =
                Math.max(ranking.score || 0, RECOMMENDATION_CONFIG.explorationMinScoreFloor) +
                noveltyBoost -
                getDiversityPenalty(signature) * 0.45;

            if (explorationScore > bestScore) {
                bestScore = explorationScore;
                bestIndex = index;
                bestSignature = signature;
            }
        });

        const [picked] = remaining.splice(bestIndex, 1);
        if (!picked || !bestSignature) break;
        commitSelection(picked, bestSignature, "explore");
    }

    return selected;
};

const trackRecommendationEvents = async (events = []) => {
    if (!events.length) return;

    try {
        console.log(`[Analytics] Attempting to record ${events.length} events...`);
        for (const event of events) {
            console.log(`[Analytics] Creating event: ${event.action} for candidate ${event.candidateUserId}`);
            await prisma.recommendationEvent.create({ data: event });
        }
        console.log(`[Analytics] Successfully recorded all ${events.length} events.`);
    } catch (error) {
        console.error("Recommendation analytics write failed:", error);
    }
};

const trackRecommendationEvent = async (event) => {
    if (!event) return;

    try {
        await prisma.recommendationEvent.create({ data: event });
    } catch (error) {
        console.error("Recommendation analytics write failed:", error.message);
    }
};

const mapPreferenceStatusToFeedbackAction = (status) => {
    if (status === "preferred") return "preferred";
    if (status === "not_preferred") return "ignored";
    return null;
};

const upsertRecommendationPreference = async ({
    userId,
    candidateUserId,
    status,
    source = "smart_connections",
    metadata = null,
}) => {
    return prisma.recommendationPreference.upsert({
        where: {
            userId_candidateUserId: {
                userId,
                candidateUserId,
            },
        },
        create: {
            userId,
            candidateUserId,
            status,
            source,
            metadata: metadata || undefined,
        },
        update: {
            status,
            source,
            metadata: metadata || undefined,
            updatedAt: new Date(),
        },
    });
};

const clearRecommendationPreference = async (userId, candidateUserId, source = "manual_toggle") => {
    return upsertRecommendationPreference({
        userId,
        candidateUserId,
        status: "none",
        source,
        metadata: null,
    });
};

const getRecommendationSource = (req, fallback = "connection_request") => {
    const source = normalizeText(req.body?.source || req.query?.source || fallback);
    return source || fallback;
};

const getRecommendationMetadata = (req = {}, extra = {}) => {
    const rawMetadata = getNestedObject(req.body?.metadata);
    return {
        ...rawMetadata,
        ...extra,
    };
};

const getFeedbackCandidateIds = async (userId) => {
    const [preferences, savedAndActionEvents] = await Promise.all([
        prisma.recommendationPreference.findMany({
            where: {
                userId,
                status: { in: RECOMMENDATION_PREFERENCE_ACTIVE_STATUSES },
            },
            orderBy: { updatedAt: "desc" },
            take: MAX_FEEDBACK_EVENTS,
            select: {
                candidateUserId: true,
                status: true,
                updatedAt: true,
                metadata: true,
            },
        }),
        prisma.recommendationEvent.findMany({
            where: {
                userId,
                action: { in: ["saved", "interested", "ignored"] },
            },
            orderBy: { createdAt: "desc" },
            take: MAX_FEEDBACK_EVENTS,
            select: {
                candidateUserId: true,
                action: true,
                createdAt: true,
                metadata: true,
            },
        }),
    ]);

    const preferenceEvents = preferences
        .map((preference) => ({
            candidateUserId: preference.candidateUserId,
            action: mapPreferenceStatusToFeedbackAction(preference.status),
            createdAt: preference.updatedAt,
            metadata: preference.metadata || {},
        }))
        .filter((event) => event.action);

    return [...preferenceEvents, ...savedAndActionEvents]
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        .slice(0, MAX_FEEDBACK_EVENTS);
};

const getRecommendationHistoryEvents = async (userId, take = 120) => {
    const events = await prisma.recommendationEvent.findMany({
        where: {
            userId,
            source: { in: SMART_RECOMMENDATION_SOURCES.concat(["manual_toggle", "manual_request"]) },
            action: { in: RECOMMENDATION_FEEDBACK_ACTIONS },
        },
        orderBy: { createdAt: "desc" },
        take,
    });
    return events;
};

const getCandidatePreviewMap = async (candidateIds = []) => {
    const uniqueIds = [...new Set(candidateIds.filter(Boolean))];
    if (uniqueIds.length === 0) return new Map();

    const candidates = await prisma.users.findMany({
        where: { id: { in: uniqueIds } },
        select: RECOMMENDATION_PREVIEW_SELECT,
    });

    return new Map(candidates.map((candidate) => [candidate.id, candidate]));
};

const formatRecommendationTimeline = (events = [], candidateMap = new Map()) =>
    events.map((event) => ({
        id: event.id,
        action: event.action,
        source: event.source,
        createdAt: event.createdAt,
        metadata: event.metadata || {},
        candidate: candidateMap.get(event.candidateUserId) || null,
    }));

const pickLatestEventsByCandidate = (events = []) => {
    const latestEventByCandidate = new Map();
    events.forEach((event) => {
        if (!latestEventByCandidate.has(event.candidateUserId)) {
            latestEventByCandidate.set(event.candidateUserId, event);
        }
    });
    return latestEventByCandidate;
};

const createSectionItem = (action, candidate, meta = {}) => ({
    id: `${action}-${candidate.id}`,
    action,
    candidate,
    recordedAt: meta.recordedAt || meta.createdAt || null,
    source: meta.source || null,
    requestId: meta.requestId || null,
});

const buildRecommendationSections = async (userId) => {
    const [events, preferences, interestedRequests] = await Promise.all([
        prisma.recommendationEvent.findMany({
            where: {
                userId,
                source: { in: SMART_RECOMMENDATION_SOURCES },
                action: { in: ["shown", "saved", "ignored"] },
            },
            orderBy: { createdAt: "desc" },
            take: 800,
        }),
        prisma.recommendationPreference.findMany({
            where: {
                userId,
                status: { in: RECOMMENDATION_PREFERENCE_ACTIVE_STATUSES },
            },
            orderBy: { updatedAt: "desc" },
            take: 400,
            select: {
                candidateUserId: true,
                status: true,
                source: true,
                updatedAt: true,
            },
        }),
        prisma.connectionsRequest.findMany({
            where: {
                fromUserId: userId,
                status: "interested",
            },
            orderBy: { updatedAt: "desc" },
            take: 400,
            select: {
                id: true,
                toUserId: true,
                updatedAt: true,
            },
        }),
    ]);

    const shownEvents = pickLatestEventsByCandidate(events.filter((event) => event.action === "shown"));
    const savedEvents = pickLatestEventsByCandidate(events.filter((event) => event.action === "saved"));
    const interestedEvents = new Map(
        interestedRequests.map((request) => [request.toUserId, request])
    );
    const preferredEvents = new Map(
        preferences
            .filter((preference) => preference.status === "preferred")
            .map((preference) => [preference.candidateUserId, preference])
    );
    const notPreferredEvents = new Map(
        preferences
            .filter((preference) => preference.status === "not_preferred")
            .map((preference) => [preference.candidateUserId, preference])
    );
    const ignoredEvents = pickLatestEventsByCandidate(events.filter((event) => event.action === "ignored"));

    const candidateIds = [
        ...shownEvents.keys(),
        ...savedEvents.keys(),
        ...interestedEvents.keys(),
        ...preferredEvents.keys(),
        ...notPreferredEvents.keys(),
        ...ignoredEvents.keys(),
    ];

    const candidateMap = await getCandidatePreviewMap(candidateIds);

    return {
        shown: [...shownEvents.values()]
            .map((event) => {
                const candidate = candidateMap.get(event.candidateUserId);
                return candidate ? createSectionItem("shown", candidate, event) : null;
            })
            .filter(Boolean),
        saved: [...savedEvents.values()]
            .map((event) => {
                const candidate = candidateMap.get(event.candidateUserId);
                return candidate ? createSectionItem("saved", candidate, event) : null;
            })
            .filter(Boolean),
        interested: [...interestedEvents.values()]
            .map((request) => {
                const candidate = candidateMap.get(request.toUserId);
                return candidate
                    ? createSectionItem("interested", candidate, {
                        recordedAt: request.updatedAt,
                        source: "connection_request",
                        requestId: request.id,
                    })
                    : null;
            })
            .filter(Boolean),
        preferred: [...preferredEvents.values()]
            .map((event) => {
                const candidate = candidateMap.get(event.candidateUserId);
                return candidate
                    ? createSectionItem("preferred", candidate, {
                        recordedAt: event.updatedAt,
                        source: event.source,
                    })
                    : null;
            })
            .filter(Boolean),
        not_preferred: [...notPreferredEvents.values()]
            .map((event) => {
                const candidate = candidateMap.get(event.candidateUserId);
                return candidate
                    ? createSectionItem("not_preferred", candidate, {
                        recordedAt: event.updatedAt,
                        source: event.source,
                    })
                    : null;
            })
            .filter(Boolean),
        ignored: [...ignoredEvents.values()]
            .map((event) => {
                const candidate = candidateMap.get(event.candidateUserId);
                return candidate ? createSectionItem("ignored", candidate, event) : null;
            })
            .filter(Boolean),
    };
};

const summarizeRecommendationHistory = (events = []) => {
    const counts = {
        shown: 0,
        saved: 0,
        ignored: 0,
        interested: 0,
    };

    events.forEach((event) => {
        if (event.action === "shown") counts.shown++;
        else if (event.action === "saved") counts.saved++;
        else if (event.action === "ignored") counts.ignored++;
        else if (event.action === "interested") counts.interested++;
    });

    const shown = counts.shown || 0;
    const interested = counts.interested || 0;
    const saved = counts.saved || 0;

    return {
        counts,
        conversion: {
            interestRate: shown > 0 ? Number((interested / shown).toFixed(3)) : 0,
            saveRate: shown > 0 ? Number((saved / shown).toFixed(3)) : 0,
        },
    };
};

const incrementBucket = (map, key, amount = 1) => {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + amount);
};

const mapToSortedObject = (map, limit = null) => {
    const entries = [...map.entries()].sort((left, right) => right[1] - left[1]);
    const sliced = Number.isFinite(limit) ? entries.slice(0, limit) : entries;
    return Object.fromEntries(sliced);
};

const buildActionTrend = (events = [], days = 14) => {
    const today = new Date();
    const buckets = new Map();

    for (let index = days - 1; index >= 0; index -= 1) {
        const day = new Date(today);
        day.setHours(0, 0, 0, 0);
        day.setDate(day.getDate() - index);
        const key = day.toISOString().slice(0, 10);
        buckets.set(key, {
            shown: 0,
            saved: 0,
            ignored: 0,
            interested: 0,
        });
    }

    events.forEach((event) => {
        const key = new Date(event.createdAt).toISOString().slice(0, 10);
        const bucket = buckets.get(key);
        if (!bucket) return;
        bucket[event.action] = (bucket[event.action] || 0) + 1;
    });

    return [...buckets.entries()].map(([date, values]) => ({ date, ...values }));
};

const buildRecommendationAnalyticsSnapshot = (events = [], label = "personal") => {
    const summary = summarizeRecommendationHistory(events);
    const sourceBreakdown = new Map();
    const deliveryBreakdown = new Map();
    const confidenceBreakdown = new Map();
    const profileQualityBreakdown = new Map();
    const selectionModeBreakdown = new Map();
    const clusterBreakdown = new Map();
    const profileTypeBreakdown = new Map();
    const locationBreakdown = new Map();
    const backgroundBreakdown = new Map();
    const uniqueCandidates = new Set();

    events.forEach((event) => {
        uniqueCandidates.add(event.candidateUserId);
        incrementBucket(sourceBreakdown, event.source || "unknown");
        incrementBucket(deliveryBreakdown, event.metadata?.delivery || "untracked");
        incrementBucket(confidenceBreakdown, event.metadata?.matchConfidence || "unknown");
        incrementBucket(profileQualityBreakdown, event.metadata?.profileQualityLabel || "unknown");
        incrementBucket(selectionModeBreakdown, event.metadata?.selectionMode || "unknown");
        incrementBucket(clusterBreakdown, event.metadata?.diversity?.clusterKey || "cluster:unknown");
        incrementBucket(profileTypeBreakdown, event.metadata?.diversity?.profileType || "generalist");
        incrementBucket(locationBreakdown, event.metadata?.diversity?.locationBucket || "location:unknown");
        incrementBucket(backgroundBreakdown, event.metadata?.diversity?.backgroundKey || "background:unknown");
    });

    return {
        label,
        counts: summary.counts,
        conversion: summary.conversion,
        uniqueCandidates: uniqueCandidates.size,
        sourceBreakdown: mapToSortedObject(sourceBreakdown),
        deliveryBreakdown: mapToSortedObject(deliveryBreakdown),
        confidenceBreakdown: mapToSortedObject(confidenceBreakdown),
        profileQualityBreakdown: mapToSortedObject(profileQualityBreakdown),
        selectionModeBreakdown: mapToSortedObject(selectionModeBreakdown),
        diversityBreakdown: {
            clusters: mapToSortedObject(clusterBreakdown, 8),
            profileTypes: mapToSortedObject(profileTypeBreakdown, 8),
            locations: mapToSortedObject(locationBreakdown, 8),
            backgrounds: mapToSortedObject(backgroundBreakdown, 8),
        },
        trend: buildActionTrend(events, 14),
        funnel: {
            shown: summary.counts.shown || 0,
            saved: summary.counts.saved || 0,
            ignored: summary.counts.ignored || 0,
            interested: summary.counts.interested || 0,
        },
    };
};

const getLatestInterestedEventSource = async (fromUserId, toUserId) => {
    const event = await prisma.recommendationEvent.findFirst({
        where: {
            userId: fromUserId,
            candidateUserId: toUserId,
            action: "interested",
            source: { in: SMART_RECOMMENDATION_SOURCES },
        },
        orderBy: { createdAt: "desc" },
        select: { source: true },
    });

    return event?.source || "connection_review";
};

const getSharedItems = (left = [], right = []) => {
    const rightLookup = new Map(right.map((item) => [item.toLowerCase(), item]));
    return left.filter((item) => rightLookup.has(item.toLowerCase()));
};

const getMatchConfidence = (score, profileQualityScore = 1) => {
    if (score < RECOMMENDATION_CONFIG.lowConfidenceScore || profileQualityScore < RECOMMENDATION_CONFIG.lowProfileQualityScore) {
        return "Low-confidence match";
    }
    if (score >= 0.82) return "High match";
    if (score >= 0.62) return "Strong match";
    if (score >= 0.42) return "Relevant match";
    return "Potential match";
};

const scoreExplicitPreferenceMatch = (userExpertise = {}, candidate = {}) => {
    const preferenceProfile = buildExplicitPreferenceProfile(userExpertise);
    if (!preferenceProfile.hasSignal) {
        return { score: 0, reasons: [] };
    }

    const candidateSignals = buildProfileSignals(candidate.expertise || {});
    const candidateRole = detectProfileType(candidateSignals);
    const candidateLocation = detectLocationBucket(candidate.expertise || {}, candidateSignals);
    const candidateExperienceLevel = detectExperienceLevel(candidate.expertise || {}, candidateSignals);
    const candidateIndustries = normalizeTerms([
        candidate.expertise?.industry,
        candidate.expertise?.industries,
    ]);
    const candidateLanguages = normalizeTerms(candidate.expertise?.languages);
    const candidateLookingFor = normalizeTerms([
        candidate.expertise?.lookingFor,
        candidate.expertise?.openTo,
        candidate.expertise?.goals,
    ]);
    const candidateSearchSpace = [
        candidateRole,
        candidateLocation,
        candidateExperienceLevel,
        ...candidateSignals.skills,
        ...candidateSignals.interests,
        ...candidateIndustries,
        ...candidateLanguages,
        ...candidateLookingFor,
        candidateSignals.headline,
        ...candidateSignals.textFields,
    ].filter(Boolean).join(" ").toLowerCase();

    let score = 0;
    const reasons = [];

    const matchList = (items = [], weight = 0, label = "Preference match") => {
        const matches = normalizeTerms(items).filter((item) => candidateSearchSpace.includes(item.toLowerCase()));
        if (matches.length > 0) {
            score += Math.min(matches.length, 2) * weight;
            reasons.push(`${label}: ${matches.slice(0, 2).join(", ")}`);
        }
    };

    matchList(preferenceProfile.lookingFor, 0.045, "Shared intent");
    matchList(preferenceProfile.preferredRoles, 0.055, "Preferred role fit");
    matchList(preferenceProfile.preferredIndustries, 0.05, "Industry fit");
    matchList(preferenceProfile.preferredLocations, 0.035, "Location fit");
    matchList(preferenceProfile.preferredLanguages, 0.03, "Language fit");
    matchList(preferenceProfile.preferredExperienceLevels, 0.04, "Experience fit");

    const dealBreakerMatches = preferenceProfile.dealBreakers.filter((item) =>
        candidateSearchSpace.includes(item.toLowerCase())
    );
    if (dealBreakerMatches.length > 0) {
        score -= Math.min(dealBreakerMatches.length, 2) * 0.07;
        reasons.push(`Possible mismatch: ${dealBreakerMatches.slice(0, 2).join(", ")}`);
    }

    return {
        score: Number(clamp(score, -0.16, 0.18).toFixed(4)),
        reasons: reasons.slice(0, 2),
    };
};

const scoreCandidateReadiness = (candidate = {}) => {
    const signals = candidate.rankingSignals || {};
    const score = clamp(
        (signals.activityScore || 0) * 0.08
        + (signals.responsivenessScore || 0) * 0.1
        + (signals.outcomeScore || 0) * 0.12,
        0,
        0.24
    );

    const reasons = [];
    if ((signals.responsivenessScore || 0) >= 0.58) {
        reasons.push("Responsive candidate");
    }
    if ((signals.outcomeScore || 0) >= 0.52) {
        reasons.push("Good connection follow-through");
    }
    if ((signals.activityScore || 0) >= 0.8) {
        reasons.push("Recently active");
    }

    return {
        score: Number(score.toFixed(4)),
        reasons: reasons.slice(0, 2),
    };
};

const buildFallbackRankings = (userExpertise = {}, candidates = []) => {
    const userSignals = buildProfileSignals(userExpertise);
    const hasRichUserProfile = userSignals.completeness > 2;

    return candidates
        .map((candidate) => {
            const candidateSignals = buildProfileSignals(candidate.expertise || {});
            const profileQualityScore = getProfileQualityScore(candidate.expertise || {});
            const sharedSkills = getSharedItems(userSignals.skills, candidateSignals.skills);
            const sharedInterests = getSharedItems(userSignals.interests, candidateSignals.interests);
            const sharedTokens = [...userSignals.tokens].filter((token) => candidateSignals.tokens.has(token));
            const explicitPreferenceMatch = scoreExplicitPreferenceMatch(userExpertise, candidate);
            const candidateReadiness = scoreCandidateReadiness(candidate);

            const completenessScore = profileQualityScore * RECOMMENDATION_CONFIG.profileQualityWeight;

            let score = completenessScore;
            if (hasRichUserProfile) {
                score += sharedSkills.length * 0.3;
                score += sharedInterests.length * 0.18;
                score += Math.min(sharedTokens.length, 6) * 0.04;
                if (
                    userSignals.headline &&
                    candidateSignals.headline &&
                    candidateSignals.headline.toLowerCase().includes(userSignals.headline.toLowerCase())
                ) {
                    score += 0.08;
                }
            } else {
                score += Math.min(candidateSignals.skills.length, 5) * 0.06;
                score += Math.min(candidateSignals.interests.length, 4) * 0.04;
            }
            score += explicitPreferenceMatch.score;
            score += candidateReadiness.score;

            const reasons = [];
            if (sharedSkills.length > 0) {
                reasons.push(`Shared skills: ${sharedSkills.slice(0, 2).join(", ")}`);
            }
            if (sharedInterests.length > 0) {
                reasons.push(`Shared interests: ${sharedInterests.slice(0, 2).join(", ")}`);
            }
            if (sharedTokens.length > 0) {
                reasons.push(`Similar profile themes around ${sharedTokens.slice(0, 3).join(", ")}`);
            }
            reasons.push(...explicitPreferenceMatch.reasons);
            reasons.push(...candidateReadiness.reasons);
            if (reasons.length === 0 && candidateSignals.headline) {
                reasons.push(`Complete profile fit: ${candidateSignals.headline.slice(0, 90)}`);
            }
            if (profileQualityScore < RECOMMENDATION_CONFIG.lowProfileQualityScore) {
                reasons.push("Partial profile, so this match is lower confidence");
            }
            if (reasons.length === 0) {
                reasons.push("Good candidate based on available profile detail");
            }

            score = Math.min(score, 0.99);

            return {
                id: candidate.id,
                score: Number(score.toFixed(4)),
                reasons,
            };
        })
        .sort((left, right) => right.score - left.score);
};

const buildSmartUserPayload = (users = [], rankings = []) => {
    const userMap = new Map(users.map((user) => [user.id, user]));
    const rankingFallbackMap = new Map(rankings.map((item) => [item.id, item]));

    return rankings
        .map((ranking) => {
            const candidate = userMap.get(ranking.id);
            if (!candidate) return null;

            const score = Number(ranking.score || 0);
            const profileQualityScore = getProfileQualityScore(candidate.expertise || {});
            const reasons = Array.isArray(ranking.reasons) && ranking.reasons.length > 0
                ? ranking.reasons
                : rankingFallbackMap.get(ranking.id)?.reasons || ["Recommended for your network"];

            return {
                ...candidate,
                matchScore: score,
                matchConfidence: getMatchConfidence(score, profileQualityScore),
                profileQualityScore,
                profileQualityLabel: getProfileQualityLabel(profileQualityScore),
                selectionMode: ranking.selectionMode || "exploit",
                diversity: ranking.diversity || null,
                matchWarning:
                    profileQualityScore < RECOMMENDATION_CONFIG.lowProfileQualityScore
                        ? "Lower confidence because this profile is still incomplete."
                        : null,
                matchReasons: reasons.slice(0, 3),
                matchReason: reasons[0],
            };
        })
        .filter(Boolean);
};

const filterUsersForResponse = (users = [], excludedIds = [], limit = SMART_RECOMMENDATION_RESPONSE_SIZE) => {
    const excluded = new Set(excludedIds.filter(Boolean));
    return users.filter((user) => !excluded.has(user.id)).slice(0, limit);
};
const trackShownCandidates = async (userId, users = [], delivery = "cache") => {
    if (!users.length) return;
    console.log(`[ShownTracking] Tracking ${users.length} candidates for user ${userId} (${delivery})`);

    await trackRecommendationEvents(
        users.map((candidate) => ({
            userId,
            candidateUserId: candidate.id,
            action: "shown",
            source: "smart_connections",
            metadata: {
                delivery,
                matchScore: candidate.matchScore,
                matchConfidence: candidate.matchConfidence,
                profileQualityScore: candidate.profileQualityScore,
                profileQualityLabel: candidate.profileQualityLabel,
                selectionMode: candidate.selectionMode,
                diversity: candidate.diversity,
            },
        }))
    );
};

const getPersistentExcludedIds = async (loggedInUserId) => {
    const [connections, savedEvents] = await Promise.all([
        prisma.connectionsRequest.findMany({
            where: {
                OR: [
                    { toUserId: loggedInUserId },
                    { fromUserId: loggedInUserId },
                ],
            },
            select: { fromUserId: true, toUserId: true },
        }),
        prisma.recommendationEvent.findMany({
            where: {
                userId: loggedInUserId,
                action: "saved",
            },
            select: { candidateUserId: true }
        })
    ]);

    const excludedIds = new Set([loggedInUserId]);
    
    // 1. Exclude existing connections (interested, accepted, ignored)
    connections.forEach((conn) => {
        excludedIds.add(conn.fromUserId);
        excludedIds.add(conn.toUserId);
    });

    // 2. Exclude saved candidates (they live in the saved tab)
    savedEvents.forEach((event) => {
        excludedIds.add(event.candidateUserId);
    });

    return Array.from(excludedIds);
};

const getEligibleRecommendationCandidates = async (loggedInUserId, excludedIds = []) => {
    const notPreferredPreferences = await prisma.recommendationPreference.findMany({
        where: { userId: loggedInUserId, status: "not_preferred" },
        select: { candidateUserId: true, updatedAt: true },
    });
    const recentNotPreferredIds = notPreferredPreferences
        .filter((preference) => isWithinRecentDays(preference.updatedAt, NOT_PREFERRED_EXCLUSION_DAYS))
        .map((preference) => preference.candidateUserId);

    const strictExcluded = [...new Set([...excludedIds, ...recentNotPreferredIds])];

    const strictCandidates = await prisma.users.findMany({
        where: { id: { notIn: strictExcluded } },
        orderBy: { updatedAt: "desc" },
        select: {
            id: true,
            firstname: true,
            lastname: true,
            expertise: true,
            imageUrl: true,
            email: true,
            age: true,
            updatedAt: true,
        },
    });

    const strictEligible = strictCandidates.filter((candidate) => isDiscoverableProfile(candidate.expertise || {}));
    if (strictEligible.length > 0) {
        console.log(`[SmartUsers] Eligible candidates found: ${strictEligible.length}/${strictCandidates.length} (strict excluded: ${strictExcluded.length})`);
        return strictEligible;
    }

    if (strictCandidates.length > 0) {
        console.log(`[SmartUsers] Falling back to low-signal candidates: ${strictCandidates.length} available after strict exclusion`);
        return strictCandidates;
    }

    const relaxedCandidates = await prisma.users.findMany({
        where: { id: { notIn: excludedIds } },
        orderBy: { updatedAt: "desc" },
        select: {
            id: true,
            firstname: true,
            lastname: true,
            expertise: true,
            imageUrl: true,
            email: true,
            age: true,
            updatedAt: true,
        },
    });

    const relaxedEligible = relaxedCandidates.filter((candidate) => isDiscoverableProfile(candidate.expertise || {}));
    if (relaxedEligible.length > 0) {
        console.log(`[SmartUsers] Reusing older not-preferred candidates after pool exhaustion: ${relaxedEligible.length}`);
        return relaxedEligible;
    }

    console.log(`[SmartUsers] Final fallback to any remaining candidates: ${relaxedCandidates.length}`);
    return relaxedCandidates;
};

const getFeedbackProfileForUser = async (userId) => {
    const feedbackEvents = await getFeedbackCandidateIds(userId);
    const feedbackCandidateIds = [...new Set(feedbackEvents.map((event) => event.candidateUserId))];

    if (feedbackCandidateIds.length === 0) {
        return null;
    }

    const feedbackCandidates = await prisma.users.findMany({
        where: { id: { in: feedbackCandidateIds } },
        select: {
            id: true,
            expertise: true,
        },
    });

    const feedbackCandidateMap = new Map(feedbackCandidates.map((candidate) => [candidate.id, candidate]));
    return buildFeedbackProfile(feedbackEvents, feedbackCandidateMap);
};

const getAcceptedConnectionsForUser = async (userId) => {
    const connections = await prisma.connectionsRequest.findMany({
        where: {
            status: "accepted",
            OR: [
                { fromUserId: userId },
                { toUserId: userId },
            ],
        },
        orderBy: { updatedAt: "desc" },
        take: 16,
        select: {
            fromUserId: true,
            toUserId: true,
        },
    });

    const candidateIds = connections
        .map((connection) => (connection.fromUserId === userId ? connection.toUserId : connection.fromUserId))
        .filter(Boolean);

    if (candidateIds.length === 0) return [];

    return prisma.users.findMany({
        where: { id: { in: candidateIds } },
        select: {
            id: true,
            expertise: true,
        },
    });
};

const getCandidateActivityMap = async (candidateIds = []) => {
    const uniqueCandidateIds = [...new Set(candidateIds.filter(Boolean))];
    if (uniqueCandidateIds.length === 0) return new Map();

    const [users, inboundRequests, allAcceptedRequests, conversations] = await Promise.all([
        prisma.users.findMany({
            where: { id: { in: uniqueCandidateIds } },
            select: { id: true, updatedAt: true, createdAt: true },
        }),
        prisma.connectionsRequest.findMany({
            where: { toUserId: { in: uniqueCandidateIds } },
            select: { toUserId: true, status: true, updatedAt: true },
        }),
        prisma.connectionsRequest.findMany({
            where: {
                status: "accepted",
                OR: [
                    { fromUserId: { in: uniqueCandidateIds } },
                    { toUserId: { in: uniqueCandidateIds } },
                ],
            },
            select: { fromUserId: true, toUserId: true, updatedAt: true },
        }),
        prisma.conversation.findMany({
            where: {
                participantIds: { hasSome: uniqueCandidateIds },
            },
            select: { participantIds: true, updatedAt: true },
        }),
    ]);

    const map = new Map(uniqueCandidateIds.map((candidateId) => [candidateId, {
        inboundRequests: 0,
        acceptedInbound: 0,
        rejectedInbound: 0,
        respondedInbound: 0,
        acceptedConnections: 0,
        activeConversationCount: 0,
        lastActiveAt: null,
        updatedAt: null,
        acceptanceRate: 0,
        responseRate: 0,
        activityScore: 0,
        activityLevel: "low",
        outcomeScore: 0,
        responsivenessScore: 0,
    }]));

    users.forEach((user) => {
        const current = map.get(user.id);
        if (!current) return;
        current.updatedAt = user.updatedAt;
        current.lastActiveAt = user.updatedAt;
    });

    inboundRequests.forEach((request) => {
        const current = map.get(request.toUserId);
        if (!current) return;
        current.inboundRequests += 1;
        if (request.status === "accepted") current.acceptedInbound += 1;
        if (request.status === "rejected") current.rejectedInbound += 1;
        if (request.status === "accepted" || request.status === "rejected") current.respondedInbound += 1;
        if (!current.lastActiveAt || new Date(request.updatedAt) > new Date(current.lastActiveAt)) {
            current.lastActiveAt = request.updatedAt;
        }
    });

    allAcceptedRequests.forEach((request) => {
        [request.fromUserId, request.toUserId].forEach((candidateId) => {
            const current = map.get(candidateId);
            if (!current) return;
            current.acceptedConnections += 1;
            if (!current.lastActiveAt || new Date(request.updatedAt) > new Date(current.lastActiveAt)) {
                current.lastActiveAt = request.updatedAt;
            }
        });
    });

    conversations.forEach((conversation) => {
        const latestAt = conversation.updatedAt || null;
        (conversation.participantIds || []).forEach((candidateId) => {
            const current = map.get(candidateId);
            if (!current) return;
            current.activeConversationCount += 1;
            if (latestAt && (!current.lastActiveAt || new Date(latestAt) > new Date(current.lastActiveAt))) {
                current.lastActiveAt = latestAt;
            }
        });
    });

    uniqueCandidateIds.forEach((candidateId) => {
        const current = map.get(candidateId);
        const inboundBase = Math.max(current.inboundRequests, 1);
        current.acceptanceRate = current.acceptedInbound / inboundBase;
        current.responseRate = current.respondedInbound / inboundBase;
        current.activityScore = Number((
            getActivityRecencyScore(current.lastActiveAt || current.updatedAt)
            + Math.min(current.activeConversationCount, 6) * 0.08
            + Math.min(current.acceptedConnections, 8) * 0.04
        ).toFixed(4));
        current.activityLevel =
            current.activityScore >= 1 ? "high"
                : current.activityScore >= 0.65 ? "medium"
                    : "low";
        current.outcomeScore = Number(clamp(
            current.acceptanceRate * 0.52
            + current.responseRate * 0.28
            + Math.min(current.acceptedConnections, 10) * 0.03,
            0,
            1
        ).toFixed(4));
        current.responsivenessScore = Number(clamp(
            current.responseRate * 0.58 + current.acceptanceRate * 0.42,
            0,
            1
        ).toFixed(4));
        current.activitySummary = buildCandidateActivitySummary(current);
    });

    return map;
};

const decorateCandidatesForRanking = (candidates = [], candidateActivityMap = new Map()) =>
    candidates.map((candidate) => {
        const activity = candidateActivityMap.get(candidate.id) || {};
        return {
            ...candidate,
            rankingSignals: activity,
            expertise: {
                ...(candidate.expertise || {}),
                activitySummary: activity.activitySummary || "",
                responsivenessSummary: activity.responsivenessScore
                    ? `Responsiveness score ${(activity.responsivenessScore * 100).toFixed(0)}%`
                    : "",
                outcomeSummary: activity.outcomeScore
                    ? `Connection success score ${(activity.outcomeScore * 100).toFixed(0)}%`
                    : "",
            },
        };
    });

const mergeRankingsWithFallback = (rankedResults = [], fallbackRankings = []) => {
    const rankingById = new Map(fallbackRankings.map((item) => [item.id, item]));
    const mergedRankings = rankedResults
        .map((ranking) => {
            const fallback = rankingById.get(ranking.id);
            if (!fallback) return null;

            return {
                id: ranking.id,
                score: typeof ranking.score === "number" ? ranking.score : fallback.score,
                reasons: Array.isArray(ranking.reasons) && ranking.reasons.length > 0
                    ? ranking.reasons
                    : fallback.reasons,
            };
        })
        .filter(Boolean);

    if (mergedRankings.length === 0) {
        return fallbackRankings;
    }

    return mergedRankings.sort((left, right) => right.score - left.score);
};

const buildRankedRecommendationBatch = ({
    candidates = [],
    fallbackRankings = [],
    rankedResults = [],
    feedbackProfile = null,
    userExpertise = {},
    limit = SMART_RECOMMENDATION_BATCH_SIZE,
}) => {
    try {
        const candidateMap = new Map(candidates.map((candidate) => [candidate.id, candidate]));
        const mergedRankings = mergeRankingsWithFallback(rankedResults, fallbackRankings);
        const preferenceAdjustedRankings = mergedRankings.map((ranking) => {
            const candidate = candidateMap.get(ranking.id);
            if (!candidate) return ranking;

            const explicitPreferenceMatch = scoreExplicitPreferenceMatch(userExpertise, candidate);
            const candidateReadiness = scoreCandidateReadiness(candidate);
            const reasons = [
                ...(ranking.reasons || []),
                ...explicitPreferenceMatch.reasons,
                ...candidateReadiness.reasons,
            ].slice(0, 4);

            return {
                ...ranking,
                score: Number(clamp((ranking.score || 0) + explicitPreferenceMatch.score + candidateReadiness.score, 0, 0.99).toFixed(4)),
                reasons,
            };
        });
        const feedbackAdjustedRankings = applyFeedbackToRankings(preferenceAdjustedRankings, candidateMap, feedbackProfile);

        const minScore = RECOMMENDATION_CONFIG.minimumMatchScore;
        const qualifiedRankings = feedbackAdjustedRankings.filter(
            (ranking) => ranking.score >= minScore
        );

        const sourceRankings = qualifiedRankings.length > 0 ? qualifiedRankings : feedbackAdjustedRankings;
        console.log(`[Ranking] Qualified: ${qualifiedRankings.length}/${feedbackAdjustedRankings.length} (min: ${minScore})`);

        const diverseRankings = selectBalancedRankings(sourceRankings, candidateMap, limit);
        return buildSmartUserPayload(candidates, diverseRankings).slice(0, limit);
    } catch (error) {
        console.error("[Ranking] Batch construction failed:", error.message);
        return buildSmartUserPayload(candidates, fallbackRankings.slice(0, limit));
    }
};

const getMatchingAgentPayload = (userExpertise = {}, historyProfile = null, candidates = []) => ({
    userProfile: userExpertise,
    historyProfile,
    topK: Math.max(SMART_RECOMMENDATION_BATCH_SIZE * 3, SMART_RECOMMENDATION_RESPONSE_SIZE),
    candidates: candidates.map((candidate) => ({
        id: candidate.id,
        firstname: candidate.firstname,
        lastname: candidate.lastname,
        age: candidate.age,
        imageUrl: candidate.imageUrl,
        email: candidate.email,
        expertise: candidate.expertise || {},
    })),
});

const refreshRecommendationCacheInBackground = ({
    userId,
    userExpertise,
    historyProfile,
    candidates,
    fallbackRankings,
    feedbackProfile,
}) => {
    if (!userId || !Array.isArray(candidates) || candidates.length === 0) return;

    const llmServiceUrl = process.env.LLM_SERVICE_URL || "http://localhost:8000";

    Promise.resolve()
        .then(async () => {
            let rankedResults = fallbackRankings;
            let strategy = "fallback";

            try {
                const agentResponse = await axios.post(
                    `${llmServiceUrl}/api/match/match`,
                    getMatchingAgentPayload(userExpertise || {}, historyProfile, candidates),
                    { timeout: AI_MATCH_TIMEOUT_MS }
                );

                if (Array.isArray(agentResponse.data?.rankedResults) && agentResponse.data.rankedResults.length > 0) {
                    rankedResults = agentResponse.data.rankedResults;
                    strategy = "ai";
                }
            } catch (agentError) {
                console.error("AI Smart Matching warm-cache failed:", agentError.message);
            }

            const users = buildRankedRecommendationBatch({
                candidates,
                fallbackRankings,
                rankedResults,
                feedbackProfile,
                userExpertise,
                limit: SMART_RECOMMENDATION_BATCH_SIZE,
            });

            if (users.length > 0) {
                await setCachedRecommendationBatch(userId, getRecommendationCachePayload(users, strategy));
            }
        })
        .catch((error) => {
            console.error("Recommendation background refresh failed:", error.message);
        });
};

const prepareSmartRecommendationContext = async (loggedInUserId) => {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] Context: Fetching user ${loggedInUserId}...\n`);
    const user = await prisma.users.findUnique({
        where: { id: loggedInUserId },
        select: { id: true, expertise: true },
    });

    fs.appendFileSync(logFile, `[${new Date().toISOString()}] Context: Fetching exclusions...\n`);
    const persistentExcludedIds = await getPersistentExcludedIds(loggedInUserId);

    fs.appendFileSync(logFile, `[${new Date().toISOString()}] Context: Starting Promise.all for candidates/feedback/connections...\n`);
    const [eligibleCandidates, feedbackProfile, acceptedConnections] = await Promise.all([
        getEligibleRecommendationCandidates(loggedInUserId, persistentExcludedIds),
        getFeedbackProfileForUser(loggedInUserId),
        getAcceptedConnectionsForUser(loggedInUserId),
    ]);
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] Context: Promise.all complete.\n`);
    const candidateActivityMap = await getCandidateActivityMap(eligibleCandidates.map((candidate) => candidate.id));
    const rankableCandidates = decorateCandidatesForRanking(eligibleCandidates, candidateActivityMap);
    const historyProfile = buildHistoryProfile(user?.expertise || {}, feedbackProfile, acceptedConnections);
    const compositeUserProfile = buildCompositeMatchingProfile(user?.expertise || {}, historyProfile);

    return {
        user,
        persistentExcludedIds,
        eligibleCandidates: rankableCandidates,
        candidateActivityMap,
        feedbackProfile,
        historyProfile,
        compositeUserProfile,
        fallbackRankings: buildFallbackRankings(compositeUserProfile, rankableCandidates),
    };
};

const warmRecommendationCacheForUser = async (loggedInUserId) => {
    if (!loggedInUserId) return null;

    try {
        console.log(`[Warmup] Starting for user ${loggedInUserId}`);
        const context = await prepareSmartRecommendationContext(loggedInUserId);

        if (context.eligibleCandidates.length === 0) {
            console.log(`[Warmup] No eligible candidates for ${loggedInUserId}`);
            await setCachedRecommendationBatch(
                loggedInUserId,
                getRecommendationCachePayload([], "empty"),
                Math.max(30, Math.floor(SMART_RECOMMENDATION_CACHE_TTL_SECONDS / 3))
            );
            return context;
        }

        refreshRecommendationCacheInBackground({
            userId: loggedInUserId,
            userExpertise: context.compositeUserProfile || context.user?.expertise || {},
            historyProfile: context.historyProfile,
            candidates: context.eligibleCandidates,
            fallbackRankings: context.fallbackRankings,
            feedbackProfile: context.feedbackProfile,
        });

        return context;
    } catch (error) {
        console.error(`[Warmup] Failed for ${loggedInUserId}:`, error.message);
        return null;
    }
};


module.exports = {
  logFile,
  axios,
  redisClient,
  PLACEHOLDER_VALUES,
  parseNumber,
  MAX_FEEDBACK_EVENTS,
  SMART_RECOMMENDATION_BATCH_SIZE,
  SMART_RECOMMENDATION_RESPONSE_SIZE,
  SMART_RECOMMENDATION_CACHE_TTL_SECONDS,
  AI_MATCH_TIMEOUT_MS,
  NOT_PREFERRED_EXCLUSION_DAYS,
  RECOMMENDATION_CONFIG,
  SMART_RECOMMENDATION_SOURCES,
  RECOMMENDATION_FEEDBACK_ACTIONS,
  RECOMMENDATION_PREFERENCE_ACTIVE_STATUSES,
  RECOMMENDATION_PREVIEW_SELECT,
  normalizeText,
  isMeaningfulText,
  normalizeTerms,
  getNestedObject,
  getExplicitPreferenceValue,
  summarizeList,
  tokenize,
  buildExplicitPreferenceProfile,
  buildProfileSignals,
  detectExperienceLevel,
  getProfileQualityScore,
  getProfileQualityLabel,
  isDiscoverableProfile,
  clamp,
  recommendationCacheMemory,
  getRecommendationCacheKey,
  getRecommendationCachePayload,
  getRecommendationCacheHash,
  getMemoryCachedRecommendations,
  setMemoryCachedRecommendations,
  deleteMemoryCachedRecommendations,
  getCachedRecommendationBatch,
  setCachedRecommendationBatch,
  invalidateRecommendationCache,
  detectProfileType,
  detectLocationBucket,
  detectBackgroundKey,
  getClusterKey,
  buildCandidateActivitySummary,
  getActivityRecencyScore,
  createWeightedMap,
  addWeightedTerms,
  getFeedbackRecencyMultiplier,
  isWithinRecentDays,
  buildFeedbackProfile,
  getTopWeightedTerms,
  buildHistoryProfile,
  buildCompositeMatchingProfile,
  getWeightedSum,
  applyFeedbackToRankings,
  selectBalancedRankings,
  trackRecommendationEvents,
  trackRecommendationEvent,
  mapPreferenceStatusToFeedbackAction,
  upsertRecommendationPreference,
  clearRecommendationPreference,
  getRecommendationSource,
  getRecommendationMetadata,
  getFeedbackCandidateIds,
  getRecommendationHistoryEvents,
  getCandidatePreviewMap,
  formatRecommendationTimeline,
  pickLatestEventsByCandidate,
  createSectionItem,
  buildRecommendationSections,
  summarizeRecommendationHistory,
  incrementBucket,
  mapToSortedObject,
  buildActionTrend,
  buildRecommendationAnalyticsSnapshot,
  getLatestInterestedEventSource,
  getSharedItems,
  getMatchConfidence,
  scoreExplicitPreferenceMatch,
  scoreCandidateReadiness,
  buildFallbackRankings,
  buildSmartUserPayload,
  filterUsersForResponse,
  trackShownCandidates,
  getPersistentExcludedIds,
  getEligibleRecommendationCandidates,
  getFeedbackProfileForUser,
  getAcceptedConnectionsForUser,
  getCandidateActivityMap,
  decorateCandidatesForRanking,
  mergeRankingsWithFallback,
  buildRankedRecommendationBatch,
  getMatchingAgentPayload,
  refreshRecommendationCacheInBackground,
  prepareSmartRecommendationContext,
  warmRecommendationCacheForUser
};
