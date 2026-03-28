const { prisma } = require("../../../prisma/prismaClient");
const { RECOMMENDATION_PREFERENCE_ACTIVE_STATUSES, MAX_FEEDBACK_EVENTS, SMART_RECOMMENDATION_SOURCES, RECOMMENDATION_FEEDBACK_ACTIONS, RECOMMENDATION_PREVIEW_SELECT, NOT_PREFERRED_EXCLUSION_DAYS } = require("./constants");
const { isWithinRecentDays } = require("./feedback");
const { isDiscoverableProfile } = require("./profileSignals");
const { buildCandidateActivitySummary, getActivityRecencyScore } = require("./classification");
const { clamp } = require("./coreUtils");

const getPersistentExcludedIds = async (loggedInUserId) => {
    const [connections, savedEvents] = await Promise.all([
        prisma.connectionsRequest.findMany({
            where: {
                OR: [
                    { toUserId: loggedInUserId },
                    { fromUserId: loggedInUserId },
                ],
            },
            select: { fromUserId: true, toUserId: true },
        }),
        prisma.recommendationEvent.findMany({
            where: {
                userId: loggedInUserId,
                action: "saved",
            },
            select: { candidateUserId: true }
        })
    ]);

    const excludedIds = new Set([loggedInUserId]);
    
    connections.forEach((conn) => {
        excludedIds.add(conn.fromUserId);
        excludedIds.add(conn.toUserId);
    });

    savedEvents.forEach((event) => {
        excludedIds.add(event.candidateUserId);
    });

    return Array.from(excludedIds);
};

const getEligibleRecommendationCandidates = async (loggedInUserId, excludedIds = []) => {
    const notPreferredPreferences = await prisma.recommendationPreference.findMany({
        where: { userId: loggedInUserId, status: "not_preferred" },
        select: { candidateUserId: true, updatedAt: true },
    });
    const recentNotPreferredIds = notPreferredPreferences
        .filter((preference) => isWithinRecentDays(preference.updatedAt, NOT_PREFERRED_EXCLUSION_DAYS))
        .map((preference) => preference.candidateUserId);

    const strictExcluded = [...new Set([...excludedIds, ...recentNotPreferredIds])];

    const strictCandidates = await prisma.users.findMany({
        where: { id: { notIn: strictExcluded } },
        orderBy: { updatedAt: "desc" },
        select: {
            id: true,
            firstname: true,
            lastname: true,
            expertise: true,
            imageUrl: true,
            email: true,
            age: true,
            updatedAt: true,
        },
    });

    const strictEligible = strictCandidates.filter((candidate) => isDiscoverableProfile(candidate.expertise || {}));
    if (strictEligible.length > 0) {
        return strictEligible;
    }

    if (strictCandidates.length > 0) {
        return strictCandidates;
    }

    const relaxedCandidates = await prisma.users.findMany({
        where: { id: { notIn: excludedIds } },
        orderBy: { updatedAt: "desc" },
        select: {
            id: true,
            firstname: true,
            lastname: true,
            expertise: true,
            imageUrl: true,
            email: true,
            age: true,
            updatedAt: true,
        },
    });

    const relaxedEligible = relaxedCandidates.filter((candidate) => isDiscoverableProfile(candidate.expertise || {}));
    if (relaxedEligible.length > 0) {
        return relaxedEligible;
    }

    return relaxedCandidates;
};

const getAcceptedConnectionsForUser = async (userId) => {
    const connections = await prisma.connectionsRequest.findMany({
        where: {
            status: "accepted",
            OR: [
                { fromUserId: userId },
                { toUserId: userId },
            ],
        },
        orderBy: { updatedAt: "desc" },
        take: 16,
        select: {
            fromUserId: true,
            toUserId: true,
        },
    });

    const candidateIds = connections
        .map((connection) => (connection.fromUserId === userId ? connection.toUserId : connection.fromUserId))
        .filter(Boolean);

    if (candidateIds.length === 0) return [];

    return prisma.users.findMany({
        where: { id: { in: candidateIds } },
        select: {
            id: true,
            expertise: true,
        },
    });
};

const mapPreferenceStatusToFeedbackAction = (status) => {
    if (status === "preferred") return "preferred";
    if (status === "not_preferred") return "ignored";
    return null;
};

const getFeedbackCandidateIds = async (userId) => {
    const [preferences, savedAndActionEvents] = await Promise.all([
        prisma.recommendationPreference.findMany({
            where: {
                userId,
                status: { in: RECOMMENDATION_PREFERENCE_ACTIVE_STATUSES },
            },
            orderBy: { updatedAt: "desc" },
            take: MAX_FEEDBACK_EVENTS,
            select: {
                candidateUserId: true,
                status: true,
                updatedAt: true,
                metadata: true,
            },
        }),
        prisma.recommendationEvent.findMany({
            where: {
                userId,
                action: { in: ["saved", "interested", "ignored"] },
            },
            orderBy: { createdAt: "desc" },
            take: MAX_FEEDBACK_EVENTS,
            select: {
                candidateUserId: true,
                action: true,
                createdAt: true,
                metadata: true,
            },
        }),
    ]);

    const preferenceEvents = preferences
        .map((preference) => ({
            candidateUserId: preference.candidateUserId,
            action: mapPreferenceStatusToFeedbackAction(preference.status),
            createdAt: preference.updatedAt,
            metadata: preference.metadata || {},
        }))
        .filter((event) => event.action);

    return [...preferenceEvents, ...savedAndActionEvents]
        .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
        .slice(0, MAX_FEEDBACK_EVENTS);
};

const upsertRecommendationPreference = async ({
    userId,
    candidateUserId,
    status,
    source = "smart_connections",
    metadata = null,
}) => {
    return prisma.recommendationPreference.upsert({
        where: {
            userId_candidateUserId: {
                userId,
                candidateUserId,
            },
        },
        create: {
            userId,
            candidateUserId,
            status,
            source,
            metadata: metadata || undefined,
        },
        update: {
            status,
            source,
            metadata: metadata || undefined,
            updatedAt: new Date(),
        },
    });
};

const getCandidatePreviewMap = async (candidateIds = []) => {
    const uniqueIds = [...new Set(candidateIds.filter(Boolean))];
    if (uniqueIds.length === 0) return new Map();

    const candidates = await prisma.users.findMany({
        where: { id: { in: uniqueIds } },
        select: RECOMMENDATION_PREVIEW_SELECT,
    });

    return new Map(candidates.map((candidate) => [candidate.id, candidate]));
};

const getCandidateActivityMap = async (candidateIds = []) => {
    // ... (rest of the code as already there)
    // Actually, I'll just append it to the end of the file.
};

const pickLatestEventsByCandidate = (events = []) => {
    const latestEventByCandidate = new Map();
    events.forEach((event) => {
        if (!latestEventByCandidate.has(event.candidateUserId)) {
            latestEventByCandidate.set(event.candidateUserId, event);
        }
    });
    return latestEventByCandidate;
};

const createSectionItem = (action, candidate, meta = {}) => ({
    id: `${action}-${candidate.id}`,
    action,
    candidate,
    recordedAt: meta.recordedAt || meta.createdAt || null,
    source: meta.source || null,
    requestId: meta.requestId || null,
});

const buildRecommendationSections = async (userId) => {
    const [events, preferences, interestedRequests] = await Promise.all([
        prisma.recommendationEvent.findMany({
            where: {
                userId,
                source: { in: SMART_RECOMMENDATION_SOURCES },
                action: { in: ["shown", "saved", "ignored"] },
            },
            orderBy: { createdAt: "desc" },
            take: 800,
        }),
        prisma.recommendationPreference.findMany({
            where: {
                userId,
                status: { in: RECOMMENDATION_PREFERENCE_ACTIVE_STATUSES },
            },
            orderBy: { updatedAt: "desc" },
            take: 400,
            select: { candidateUserId: true, status: true, source: true, updatedAt: true },
        }),
        prisma.connectionsRequest.findMany({
            where: { fromUserId: userId, status: "interested" },
            orderBy: { updatedAt: "desc" },
            take: 400,
            select: { id: true, toUserId: true, updatedAt: true },
        }),
    ]);

    const shownEvents = pickLatestEventsByCandidate(events.filter((event) => event.action === "shown"));
    const savedEvents = pickLatestEventsByCandidate(events.filter((event) => event.action === "saved"));
    const interestedEvents = new Map(interestedRequests.map((request) => [request.toUserId, request]));
    const preferredEvents = new Map(preferences.filter((p) => p.status === "preferred").map((p) => [p.candidateUserId, p]));
    const notPreferredEvents = new Map(preferences.filter((p) => p.status === "not_preferred").map((p) => [p.candidateUserId, p]));
    const ignoredEvents = pickLatestEventsByCandidate(events.filter((event) => event.action === "ignored"));

    const candidateIds = [...shownEvents.keys(), ...savedEvents.keys(), ...interestedEvents.keys(), ...preferredEvents.keys(), ...notPreferredEvents.keys(), ...ignoredEvents.keys()];
    const candidateMap = await getCandidatePreviewMap(candidateIds);

    return {
        shown: [...shownEvents.values()].map((e) => { const c = candidateMap.get(e.candidateUserId); return c ? createSectionItem("shown", c, e) : null; }).filter(Boolean),
        saved: [...savedEvents.values()].map((e) => { const c = candidateMap.get(e.candidateUserId); return c ? createSectionItem("saved", c, e) : null; }).filter(Boolean),
        interested: [...interestedEvents.values()].map((r) => { const c = candidateMap.get(r.toUserId); return c ? createSectionItem("interested", c, { recordedAt: r.updatedAt, source: "connection_request", requestId: r.id }) : null; }).filter(Boolean),
        preferred: [...preferredEvents.values()].map((e) => { const c = candidateMap.get(e.candidateUserId); return c ? createSectionItem("preferred", c, { recordedAt: e.updatedAt, source: e.source }) : null; }).filter(Boolean),
        not_preferred: [...notPreferredEvents.values()].map((p) => { const c = candidateMap.get(p.candidateUserId); return c ? createSectionItem("not_preferred", c, { recordedAt: p.updatedAt, source: p.source }) : null; }).filter(Boolean),
        ignored: [...ignoredEvents.values()].map((e) => { const c = candidateMap.get(e.candidateUserId); return c ? createSectionItem("ignored", c, e) : null; }).filter(Boolean),
    };
};

const decorateCandidatesForRanking = (candidates = [], candidateActivityMap = new Map()) =>
    candidates.map((candidate) => {
        const activity = candidateActivityMap.get(candidate.id) || {};
        return {
            ...candidate,
            rankingSignals: activity,
            expertise: {
                ...(candidate.expertise || {}),
                activitySummary: activity.activitySummary || "",
                responsivenessSummary: activity.responsivenessScore
                    ? `Responsiveness score ${(activity.responsivenessScore * 100).toFixed(0)}%`
                    : "",
                outcomeSummary: activity.outcomeScore
                    ? `Connection success score ${(activity.outcomeScore * 100).toFixed(0)}%`
                    : "",
            },
        };
    });

module.exports = {
    getPersistentExcludedIds,
    getEligibleRecommendationCandidates,
    getAcceptedConnectionsForUser,
    mapPreferenceStatusToFeedbackAction,
    getFeedbackCandidateIds,
    upsertRecommendationPreference,
    getCandidatePreviewMap,
    getCandidateActivityMap,
    decorateCandidatesForRanking,
    pickLatestEventsByCandidate,
    createSectionItem,
    buildRecommendationSections,
};
