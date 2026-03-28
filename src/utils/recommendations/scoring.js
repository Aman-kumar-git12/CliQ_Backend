const { RECOMMENDATION_CONFIG } = require("./constants");
const { normalizeTerms, clamp } = require("./coreUtils");
const { buildProfileSignals, buildExplicitPreferenceProfile, getProfileQualityScore } = require("./profileSignals");
const { detectExperienceLevel, detectProfileType, detectLocationBucket } = require("./classification");

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

module.exports = {
    getSharedItems,
    getMatchConfidence,
    scoreExplicitPreferenceMatch,
    scoreCandidateReadiness,
    buildFallbackRankings,
};
