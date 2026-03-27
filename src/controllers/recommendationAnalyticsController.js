const { prisma } = require("../../prisma/prismaClient");
const {
  SMART_RECOMMENDATION_SOURCES,
  getRecommendationHistoryEvents,
  buildRecommendationAnalyticsSnapshot,
} = require('../utils/recommendationUtils');

const getRecommendationAnalytics = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const events = await getRecommendationHistoryEvents(loggedInUserId, 500);
        const summary = buildRecommendationAnalyticsSnapshot(events, "personal");

        res.json({
            counts: summary.counts,
            conversion: summary.conversion,
            uniqueCandidates: summary.uniqueCandidates,
            sourceBreakdown: summary.sourceBreakdown,
            deliveryBreakdown: summary.deliveryBreakdown,
            confidenceBreakdown: summary.confidenceBreakdown,
            profileQualityBreakdown: summary.profileQualityBreakdown,
            selectionModeBreakdown: summary.selectionModeBreakdown,
            diversityBreakdown: summary.diversityBreakdown,
            trend: summary.trend,
            funnel: summary.funnel,
            sampleSize: events.length,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

const getRecommendationAdminAnalytics = async (req, res) => {
    try {
        const [events, distinctUsers, totalUsers] = await Promise.all([
            prisma.recommendationEvent.findMany({
                where: {
                    source: { in: SMART_RECOMMENDATION_SOURCES },
                },
                orderBy: { createdAt: "desc" },
                take: 5000,
            }),
            prisma.recommendationEvent.findMany({
                where: {
                    source: { in: SMART_RECOMMENDATION_SOURCES },
                },
                distinct: ["userId"],
                select: { userId: true },
            }),
            prisma.users.count(),
        ]);

        const snapshot = buildRecommendationAnalyticsSnapshot(events, "system");
        const activeUsers = distinctUsers.length;

        res.json({
            label: snapshot.label,
            counts: snapshot.counts,
            conversion: snapshot.conversion,
            uniqueCandidates: snapshot.uniqueCandidates,
            activeUsers,
            totalUsers,
            coverageRate: totalUsers > 0 ? Number((activeUsers / totalUsers).toFixed(3)) : 0,
            sourceBreakdown: snapshot.sourceBreakdown,
            deliveryBreakdown: snapshot.deliveryBreakdown,
            confidenceBreakdown: snapshot.confidenceBreakdown,
            profileQualityBreakdown: snapshot.profileQualityBreakdown,
            selectionModeBreakdown: snapshot.selectionModeBreakdown,
            diversityBreakdown: snapshot.diversityBreakdown,
            trend: snapshot.trend,
            funnel: snapshot.funnel,
            sampleSize: events.length,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

module.exports = {
  getRecommendationAnalytics,
  getRecommendationAdminAnalytics,
};
