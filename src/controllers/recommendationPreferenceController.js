const { prisma } = require("../../prisma/prismaClient");
const {
  SMART_RECOMMENDATION_SOURCES,
  RECOMMENDATION_PREVIEW_SELECT,
  getCandidatePreviewMap,
  getRecommendationHistoryEvents,
  buildRecommendationSections,
  summarizeRecommendationHistory,
  formatRecommendationTimeline,
} = require('../utils/recommendationUtils');

const getSavedRecommendations = async (req, res) => {
    try {
        const userId = req.user.id;
        const events = await prisma.recommendationEvent.findMany({
            where: {
                userId,
                action: "saved",
                source: { in: SMART_RECOMMENDATION_SOURCES },
            },
            orderBy: { createdAt: "desc" },
            take: 200,
        });

        const latestSavedEventByCandidate = new Map();
        events.forEach((event) => {
            if (!latestSavedEventByCandidate.has(event.candidateUserId)) {
                latestSavedEventByCandidate.set(event.candidateUserId, event);
            }
        });

        const candidateMap = await getCandidatePreviewMap([...latestSavedEventByCandidate.keys()]);
        const savedProfiles = [...latestSavedEventByCandidate.values()]
            .map((event) => ({
                id: event.id,
                savedAt: event.createdAt,
                source: event.source,
                candidate: candidateMap.get(event.candidateUserId) || null,
            }))
            .filter((item) => item.candidate);

        res.json({
            savedProfiles,
            count: savedProfiles.length,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

const getRecommendationHistory = async (req, res) => {
    try {
        const userId = req.user.id;
        const events = await getRecommendationHistoryEvents(userId, 150);
        const candidateMap = await getCandidatePreviewMap(events.map((event) => event.candidateUserId));
        const sections = await buildRecommendationSections(userId);
        const summary = summarizeRecommendationHistory(events);
        const counts = {
            ...summary.counts,
            interested: sections.interested.length,
        };
        const shown = counts.shown || 0;

        res.json({
            counts,
            conversion: {
                ...summary.conversion,
                interestRate: shown > 0 ? Number(((counts.interested || 0) / shown).toFixed(3)) : 0,
            },
            sections,
            timeline: formatRecommendationTimeline(events, candidateMap),
            totalEvents: events.length,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal server error", error: error.message });
    }
};

const getInterestedUsers = async (req, res) => {
    try {
        const requests = await prisma.connectionsRequest.findMany({
            where: { fromUserId: req.user.id, status: "interested" },
            orderBy: { updatedAt: "desc" },
            select: { toUserId: true },
        });
        const candidateIds = requests.map((request) => request.toUserId);
        const users = await prisma.users.findMany({
            where: { id: { in: candidateIds } },
            select: {
                id: true, firstname: true, lastname: true, expertise: true, imageUrl: true, email: true, age: true,
            }
        });
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch interested users", error: error.message });
    }
};

const getNotInterestedUsers = async (req, res) => {
    try {
        const preferences = await prisma.recommendationPreference.findMany({
            where: { userId: req.user.id, status: "not_preferred" },
            orderBy: { updatedAt: "desc" },
            select: { candidateUserId: true },
        });
        const candidateIds = preferences.map((preference) => preference.candidateUserId);
        const users = await prisma.users.findMany({
            where: { id: { in: candidateIds } },
            select: {
                id: true, firstname: true, lastname: true, expertise: true, imageUrl: true, email: true, age: true,
            }
        });
        res.json(users);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch not-interested users", error: error.message });
    }
};

const getInterestedPreferences = async (req, res) => {
    try {
        const userId = req.user.id;
        const preferences = await prisma.recommendationPreference.findMany({
            where: { userId, status: "preferred" },
            select: { candidateUserId: true }
        });

        const candidateIds = preferences.map(p => p.candidateUserId);
        const users = await prisma.users.findMany({
            where: { id: { in: candidateIds } },
            select: RECOMMENDATION_PREVIEW_SELECT
        });

        res.json(users);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch interested preferences", error: error.message });
    }
};

const getNotInterestedPreferences = async (req, res) => {
    try {
        const userId = req.user.id;
        const preferences = await prisma.recommendationPreference.findMany({
            where: { userId, status: "not_preferred" },
            select: { candidateUserId: true }
        });

        const candidateIds = preferences.map(p => p.candidateUserId);
        const users = await prisma.users.findMany({
            where: { id: { in: candidateIds } },
            select: RECOMMENDATION_PREVIEW_SELECT
        });

        res.json(users);
    } catch (error) {
        res.status(500).json({ message: "Failed to fetch not-interested preferences", error: error.message });
    }
};

module.exports = {
    getSavedRecommendations,
    getRecommendationHistory,
    getInterestedUsers,
    getNotInterestedUsers,
    getInterestedPreferences,
    getNotInterestedPreferences,
};
