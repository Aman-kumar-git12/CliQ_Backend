const { prisma } = require("../../prisma/prismaClient");
const { getIO, getUserRoom } = require("../socket/socket");

const NOTIFICATION_TYPES = ["like", "comment", "connection_request", "connection_accepted", "mention", "reply", "repost"];
// One notification per (actor, post) for these, refreshed instead of stacked.
const PER_POST_DEDUPED_TYPES = ["like", "repost"];

const notificationInclude = {
    actor: {
        select: { id: true, firstname: true, lastname: true, imageUrl: true }
    },
    post: {
        select: { id: true, content: true, image: true }
    },
    comment: {
        select: { id: true, comment: true }
    },
};

const getUnreadCount = (userId) =>
    prisma.notification.count({ where: { recipientId: userId, isRead: false } });

// Socket delivery is best-effort: the notification is already stored, so a missing
// socket server or an offline recipient must never fail the originating request.
const emitToUser = (userId, event, payload) => {
    try {
        getIO().to(getUserRoom(userId)).emit(event, payload);
    } catch (err) {
        console.warn(`[NOTIFICATION] Socket emit skipped: ${err.message}`);
    }
};

const pushUnreadCount = async (userId) => {
    const unreadCount = await getUnreadCount(userId);
    emitToUser(userId, "notification:count", { unreadCount });
    return unreadCount;
};

/**
 * Stores a notification and pushes it to the recipient's sockets.
 * Likes and reposts are de-duplicated per (actor, post) so toggling them
 * refreshes one notification instead of stacking new ones.
 * Never throws — callers should not fail because a notification failed.
 */
const createNotification = async ({ recipientId, actorId, type, postId = null, commentId = null, connectionRequestId = null }) => {
    try {
        if (!recipientId || !actorId || recipientId === actorId) return null;
        if (!NOTIFICATION_TYPES.includes(type)) {
            throw new Error(`Unknown notification type: ${type}`);
        }

        let notification = null;

        if (PER_POST_DEDUPED_TYPES.includes(type) || type === "connection_request") {
            const existing = await prisma.notification.findFirst({
                where: PER_POST_DEDUPED_TYPES.includes(type)
                    ? { recipientId, actorId, type, postId }
                    : { recipientId, actorId, type },
                select: { id: true },
            });

            if (existing) {
                notification = await prisma.notification.update({
                    where: { id: existing.id },
                    data: { isRead: false, readAt: null, createdAt: new Date(), connectionRequestId },
                    include: notificationInclude,
                });
            }
        }

        if (!notification) {
            notification = await prisma.notification.create({
                data: { recipientId, actorId, type, postId, commentId, connectionRequestId },
                include: notificationInclude,
            });
        }

        const unreadCount = await getUnreadCount(recipientId);
        emitToUser(recipientId, "notification:new", { notification, unreadCount });
        return notification;
    } catch (err) {
        console.error("[NOTIFICATION] Failed to create notification:", err.message);
        return null;
    }
};

/**
 * Removes notifications matching `where` (e.g. on unlike) and refreshes the
 * affected recipients' unread badges. Never throws.
 */
const removeNotifications = async (where) => {
    try {
        const targets = await prisma.notification.findMany({
            where,
            select: { recipientId: true },
        });
        if (targets.length === 0) return 0;

        const { count } = await prisma.notification.deleteMany({ where });
        const recipients = [...new Set(targets.map((t) => t.recipientId))];
        await Promise.all(recipients.map(pushUnreadCount));
        return count;
    } catch (err) {
        console.error("[NOTIFICATION] Failed to remove notifications:", err.message);
        return 0;
    }
};

/**
 * Sends "mention" notifications, skipping the actor and anyone in `skipIds`
 * (e.g. the post owner who already gets a "comment" notification).
 */
const notifyMentions = async ({ mentionIds = [], actorId, postId = null, commentId = null, skipIds = [] }) => {
    const skip = new Set([actorId, ...skipIds]);
    await Promise.all(
        mentionIds
            .filter((id) => !skip.has(id))
            .map((recipientId) => createNotification({ recipientId, actorId, type: "mention", postId, commentId }))
    );
};

module.exports = {
    notifyMentions,
    NOTIFICATION_TYPES,
    notificationInclude,
    getUserRoom,
    getUnreadCount,
    pushUnreadCount,
    createNotification,
    removeNotifications,
};
