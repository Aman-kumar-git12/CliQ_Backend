const {
    normalizeText,
    isMeaningfulText,
    normalizeTerms,
    getExplicitPreferenceValue,
    summarizeList,
    tokenize,
} = require("./coreUtils");
const { RECOMMENDATION_CONFIG } = require("./constants");

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

module.exports = {
    buildExplicitPreferenceProfile,
    buildProfileSignals,
    getProfileQualityScore,
    getProfileQualityLabel,
    isDiscoverableProfile,
};
