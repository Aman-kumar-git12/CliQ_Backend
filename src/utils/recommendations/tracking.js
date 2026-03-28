const { prisma } = require("../../../prisma/prismaClient");
const { SMART_RECOMMENDATION_RESPONSE_SIZE } = require("./constants");

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

const filterUsersForResponse = (users = [], excludedIds = [], limit = SMART_RECOMMENDATION_RESPONSE_SIZE) => {
    const excluded = new Set(excludedIds.filter(Boolean));
    return users.filter((user) => !excluded.has(user.id)).slice(0, limit);
};

module.exports = {
    trackRecommendationEvents,
    trackRecommendationEvent,
    trackShownCandidates,
    filterUsersForResponse,
};
