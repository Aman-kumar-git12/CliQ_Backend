const { prisma } = require("../../../prisma/prismaClient");
const {
    normalizeText,
    normalizeTerms,
    getRecommendationMetadata,
    invalidateRecommendationCache
} = require("../../utils/recommendationUtils");

const toggleUserInterest = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const { candidateUserId } = req.params;
        const metadata = getRecommendationMetadata(req, {
            preferenceReason: normalizeText(req.body?.preferenceReason || req.body?.reason),
            feedbackTags: normalizeTerms(req.body?.feedbackTags),
        });

        const existing = await prisma.recommendationPreference.findFirst({
            where: {
                userId: loggedInUserId,
                candidateUserId,
            }
        });

        if (existing?.status === "preferred") {
            return res.json({
                success: true,
                updated: false,
                isInterested: true,
                status: "preferred",
                message: "Already marked as preferred",
            });
        }

        await prisma.recommendationPreference.upsert({
            where: { userId_candidateUserId: { userId: loggedInUserId, candidateUserId } },
            update: { status: "preferred", metadata },
            create: { userId: loggedInUserId, candidateUserId, status: "preferred", metadata }
        });

        await invalidateRecommendationCache(loggedInUserId);
        res.json({
            success: true,
            updated: true,
            isInterested: true,
            status: "preferred",
            message: "Marked as preferred",
        });
    } catch (error) {
        res.status(500).json({ message: "Failed to toggle interest", error: error.message });
    }
};

const toggleUserNotInterest = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const { candidateUserId } = req.params;
        const metadata = getRecommendationMetadata(req, {
            ignoreReason: normalizeText(req.body?.ignoreReason || req.body?.reason),
            feedbackTags: normalizeTerms(req.body?.feedbackTags),
        });

        const existing = await prisma.recommendationPreference.findFirst({
            where: { userId: loggedInUserId, candidateUserId }
        });

        if (existing?.status === "not_preferred") {
            return res.json({
                success: true,
                updated: false,
                isNotInterested: true,
                status: "not_preferred",
                message: "Already marked as not preferred",
            });
        }

        await prisma.recommendationPreference.upsert({
            where: { userId_candidateUserId: { userId: loggedInUserId, candidateUserId } },
            update: { status: "not_preferred", metadata },
            create: { userId: loggedInUserId, candidateUserId, status: "not_preferred", metadata }
        });

        await invalidateRecommendationCache(loggedInUserId, candidateUserId);

        res.json({
            success: true,
            updated: true,
            isNotInterested: true,
            status: "not_preferred",
            message: "Marked as not preferred",
        });
    } catch (error) {
        res.status(500).json({ message: "Failed to toggle not-interest", error: error.message });
    }
};

module.exports = { toggleUserInterest, toggleUserNotInterest };
