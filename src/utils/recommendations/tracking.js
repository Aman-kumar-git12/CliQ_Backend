const { prisma } = require("../../../prisma/prismaClient");
const { SMART_RECOMMENDATION_RESPONSE_SIZE } = require("./constants");
const logger = require("../logger");

const trackRecommendationEvents = async (events = []) => {
    if (!events.length) return;

    try {
        logger.info(`[Analytics] Attempting to record ${events.length} events...`);
        for (const event of events) {
            logger.info(`[Analytics] Creating event: ${event.action} for candidate ${event.candidateUserId}`);
            await prisma.recommendationEvent.create({ data: event });
        }
        logger.info(`[Analytics] Successfully recorded all ${events.length} events.`);
    } catch (error) {
        logger.error("Recommendation analytics write failed:", error);
    }
};

const trackRecommendationEvent = async (event) => {
    if (!event) return;

    try {
        await prisma.recommendationEvent.create({ data: event });
    } catch (error) {
        logger.error("Recommendation analytics write failed:", error.message);
    }
};

const trackShownCandidates = async (userId, users = [], delivery = "cache") => {
    if (!users.length) return;
    logger.info(`[ShownTracking] Tracking ${users.length} candidates for user ${userId} (${delivery})`);

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
        })),
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
