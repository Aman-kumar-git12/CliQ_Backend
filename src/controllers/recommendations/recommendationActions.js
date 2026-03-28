const { prisma } = require("../../../prisma/prismaClient");
const {
    getRecommendationSource,
    getRecommendationMetadata,
    normalizeTerms,
    trackRecommendationEvent,
    invalidateRecommendationCache,
    RECOMMENDATION_PREVIEW_SELECT,
    SMART_RECOMMENDATION_SOURCES
} = require("../../utils/recommendationUtils");

const saveRecommendationCandidate = async (req, res) => {
    try {
        const userId = req.user.id;
        const candidateUserId = req.params.candidateUserId;
        const source = getRecommendationSource(req, "smart_connections");
        const metadata = getRecommendationMetadata(req, {
            feedbackTags: normalizeTerms(req.body?.feedbackTags),
        });

        if (userId === candidateUserId) {
            return res.status(400).json({ message: "You cannot save yourself" });
        }

        const candidate = await prisma.users.findUnique({
            where: { id: candidateUserId },
            select: RECOMMENDATION_PREVIEW_SELECT,
        });

        if (!candidate) {
            return res.status(404).json({ message: "Candidate user not found" });
        }

        const existing = await prisma.recommendationEvent.findFirst({
            where: {
                userId,
                candidateUserId,
                action: "saved",
                source,
            },
            orderBy: { createdAt: "desc" },
        });

        if (!existing) {
            await trackRecommendationEvent({
                userId,
                candidateUserId,
                action: "saved",
                source,
                metadata: {
                    ...metadata,
                    savedFrom: source,
                },
            });
        }
        await invalidateRecommendationCache(userId);

        res.json({
            message: existing ? "Profile already saved" : "Profile saved successfully",
            candidate,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

const trackRecommendationShown = async (req, res) => {
    try {
        const userId = req.user.id;
        const candidateUserId = req.params.candidateUserId;
        const source = getRecommendationSource(req, "smart_connections");
        const metadata = getRecommendationMetadata(req, {
            delivery: req.body?.delivery || "active_card",
        });

        if (!candidateUserId || userId === candidateUserId) {
            return res.status(400).json({ message: "Invalid candidate user" });
        }

        const candidate = await prisma.users.findUnique({
            where: { id: candidateUserId },
            select: { id: true },
        });

        if (!candidate) {
            return res.status(404).json({ message: "Candidate user not found" });
        }

        const recentShown = await prisma.recommendationEvent.findFirst({
            where: {
                userId,
                candidateUserId,
                action: "shown",
                source,
                createdAt: {
                    gte: new Date(Date.now() - 15 * 1000),
                },
            },
            orderBy: { createdAt: "desc" },
            select: { id: true },
        });

        if (!recentShown) {
            await trackRecommendationEvent({
                userId,
                candidateUserId,
                action: "shown",
                source,
                metadata,
            });
        }

        return res.json({
            tracked: !recentShown,
            message: recentShown ? "Shown already tracked recently" : "Shown tracked",
        });
    } catch (error) {
        return res.status(500).json({ message: "Failed to track shown state", error: error.message });
    }
};

const removeSavedRecommendation = async (req, res) => {
    try {
        const userId = req.user.id;
        const candidateUserId = req.params.candidateUserId;

        const deleted = await prisma.recommendationEvent.deleteMany({
            where: {
                userId,
                candidateUserId,
                action: "saved",
                source: { in: SMART_RECOMMENDATION_SOURCES },
            },
        });
        await invalidateRecommendationCache(userId);

        res.json({
            message: "Saved profile removed",
            removedCount: deleted.count,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

module.exports = { saveRecommendationCandidate, trackRecommendationShown, removeSavedRecommendation };
