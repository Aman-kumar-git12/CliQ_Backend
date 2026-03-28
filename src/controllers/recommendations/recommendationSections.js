const { prisma } = require("../../../prisma/prismaClient");
const {
    invalidateRecommendationCache,
    SMART_RECOMMENDATION_SOURCES,
    RECOMMENDATION_PREFERENCE_ACTIVE_STATUSES
} = require("../../utils/recommendationUtils");

const removeRecommendationSectionItem = async (req, res) => {
    try {
        const userId = req.user.id;
        const { action, candidateUserId } = req.params;

        const validActions = ["shown", "saved", "interested", "ignored", "preferred", "my_interest", "not_preferred"];
        if (!validActions.includes(action)) {
            return res.status(400).json({ message: "Invalid section action" });
        }

        let removedCount = 0;

        if (action === "shown" || action === "saved") {
            const deleted = await prisma.recommendationEvent.deleteMany({
                where: {
                    userId,
                    candidateUserId,
                    action: action === "saved" ? "saved" : "shown",
                    source: { in: SMART_RECOMMENDATION_SOURCES.concat(["manual_toggle"]) },
                },
            });
            removedCount = deleted.count;
        } else if (action === "interested") {
            const deleted = await prisma.connectionsRequest.deleteMany({
                where: { fromUserId: userId, toUserId: candidateUserId, status: "interested" },
            });
            removedCount = deleted.count;
        } else if (action === "ignored") {
            const deleted = await prisma.recommendationEvent.deleteMany({
                where: { userId, candidateUserId, action: "ignored" }
            });
            removedCount = deleted.count;
        } else if (action === "my_interest" || action === "preferred" || action === "not_preferred") {
            const status = action === "my_interest" || action === "preferred"
                ? "preferred"
                : "not_preferred";

            const deleted = await prisma.recommendationPreference.deleteMany({
                where: { userId, candidateUserId, status }
            });
            removedCount = deleted.count;
        }

        await invalidateRecommendationCache(userId);
        res.json({ message: `${action} item removed`, removedCount });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

const resetRecommendationSection = async (req, res) => {
    try {
        const userId = req.user.id;
        const { action } = req.params;

        const validActions = ["shown", "saved", "interested", "ignored", "preferred", "my_interest", "not_preferred"];
        if (!validActions.includes(action)) {
            return res.status(400).json({ message: "Invalid section action" });
        }

        if (action === "shown" || action === "saved") {
            await prisma.recommendationEvent.deleteMany({
                where: {
                    userId,
                    action: action === "saved" ? "saved" : "shown",
                },
            });
        } else if (action === "interested") {
            await prisma.connectionsRequest.deleteMany({
                where: { fromUserId: userId, status: "interested" },
            });
        } else if (action === "ignored") {
            await prisma.recommendationEvent.deleteMany({
                where: { userId, action: "ignored" }
            });
        } else if (action === "my_interest" || action === "preferred" || action === "not_preferred") {
            const status = action === "my_interest" || action === "preferred"
                ? "preferred"
                : "not_preferred";

            await prisma.recommendationPreference.deleteMany({
                where: { userId, status }
            });
        }

        await invalidateRecommendationCache(userId);
        res.json({ success: true, message: `${action} section reset successful` });
    } catch (error) {
        res.status(500).json({ message: "Failed to reset section", error: error.message });
    }
};

module.exports = { removeRecommendationSectionItem, resetRecommendationSection };
