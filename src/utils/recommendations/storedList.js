// Get Connections lists stored in MongoDB: a request reads the ready-made list instead of waiting for
// ranking (and for the AI agent, which may be asleep on Render). Ranking runs in the background and
// saves its result here; Redis stays in front as a short-lived hot copy.
const { prisma } = require("../../../prisma/prismaClient");
const { RECOMMENDATION_PREVIEW_SELECT } = require("./constants");
const logger = require("../logger");

// A list older than this is still shown, and recomputed in the background for next time
const STORED_LIST_MAX_AGE_MS = 6 * 60 * 60 * 1000;

// Strategies that are placeholders, not real rankings, so they are never stored
const UNSTORED_STRATEGIES = new Set(["seed", "empty"]);

// The ranking fields of a recommended user; everything else is profile data, loaded fresh when shown
const RANKING_FIELDS = [
    "id",
    "matchScore",
    "matchConfidence",
    "profileQualityScore",
    "profileQualityLabel",
    "selectionMode",
    "diversity",
    "matchWarning",
    "matchReasons",
    "matchReason",
];

const toStoredItem = (user) => Object.fromEntries(RANKING_FIELDS.map((field) => [field, user[field] ?? null]));

// rankedFrom: when the ranking that produced this list started reading data. A change marked after that
// (markStoredListsStale while the ranking ran) isn't reflected in this list, so the list stays stale and is
// ranked again. Returns { stale } for the hot copy.
const saveStoredList = async (userId, payload, { rankedFrom = new Date() } = {}) => {
    if (!userId || UNSTORED_STRATEGIES.has(payload?.strategy) || !payload?.users?.length) return { stale: false };

    const data = {
        items: payload.users.map(toStoredItem),
        strategy: payload.strategy,
        computedAt: new Date(),
    };
    try {
        const saved = await prisma.recommendationList.upsert({
            where: { userId },
            create: { userId, ...data, staleAt: null },
            update: data,
            select: { staleAt: true },
        });
        if (saved.staleAt && saved.staleAt >= rankedFrom) return { stale: true };
        // Clears only a mark older than this ranking, so one made in between can't be lost
        if (saved.staleAt) {
            await prisma.recommendationList.updateMany({
                where: { userId, staleAt: { lt: rankedFrom } },
                data: { staleAt: null },
            });
        }
    } catch (error) {
        logger.error(`[StoredList] Save failed for ${userId}:`, error.message);
    }
    return { stale: false };
};

// The stored list with current profile data, in ranked order. Users deleted since are dropped.
// Returns null when there is no list yet.
const loadStoredList = async (userId) => {
    try {
        const list = await prisma.recommendationList.findUnique({ where: { userId } });
        const items = Array.isArray(list?.items) ? list.items : [];
        if (items.length === 0) return null;

        const profiles = await prisma.users.findMany({
            where: { id: { in: items.map((item) => item.id) } },
            select: RECOMMENDATION_PREVIEW_SELECT,
        });
        const profileById = new Map(profiles.map((profile) => [profile.id, profile]));

        return {
            users: items
                .filter((item) => profileById.has(item.id))
                .map((item) => ({ ...profileById.get(item.id), ...item })),
            strategy: list.strategy,
            cachedAt: list.computedAt.toISOString(),
            isStale: Boolean(list.staleAt) || Date.now() - list.computedAt.getTime() > STORED_LIST_MAX_AGE_MS,
        };
    } catch (error) {
        logger.error(`[StoredList] Load failed for ${userId}:`, error.message);
        return null;
    }
};

// Keeps the lists but marks them for a background recompute on their next read
const markStoredListsStale = async (userIds) => {
    if (userIds.length === 0) return;
    try {
        // Always the latest change time: saveStoredList compares it with when a running ranking started
        await prisma.recommendationList.updateMany({
            where: { userId: { in: userIds } },
            data: { staleAt: new Date() },
        });
    } catch (error) {
        logger.error("[StoredList] Mark stale failed:", error.message);
    }
};

module.exports = { STORED_LIST_MAX_AGE_MS, saveStoredList, loadStoredList, markStoredListsStale };
