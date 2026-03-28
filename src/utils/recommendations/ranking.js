const { RECOMMENDATION_CONFIG, SMART_RECOMMENDATION_BATCH_SIZE } = require("./constants");
const { clamp } = require("./coreUtils");
const { buildProfileSignals, getProfileQualityScore, getProfileQualityLabel } = require("./profileSignals");
const { detectExperienceLevel, detectProfileType, detectLocationBucket, detectBackgroundKey, getClusterKey } = require("./classification");
const { getMatchConfidence, scoreExplicitPreferenceMatch, scoreCandidateReadiness } = require("./scoring");

const getWeightedSum = (map, items = []) =>
    items.reduce((sum, item) => sum + (map.get(item.toLowerCase()) || 0), 0);

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

module.exports = {
    applyFeedbackToRankings,
    selectBalancedRankings,
    buildSmartUserPayload,
    mergeRankingsWithFallback,
    buildRankedRecommendationBatch,
};
