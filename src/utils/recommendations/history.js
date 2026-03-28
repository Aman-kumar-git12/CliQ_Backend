const { normalizeTerms } = require("./coreUtils");
const { buildExplicitPreferenceProfile, buildProfileSignals } = require("./profileSignals");
const { getTopWeightedTerms } = require("./feedback");

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

module.exports = {
    buildHistoryProfile,
    buildCompositeMatchingProfile,
};
