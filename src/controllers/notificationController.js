const { prisma } = require("../../prisma/prismaClient");
const { notificationInclude, getUnreadCount, pushUnreadCount } = require("../utils/notificationUtils");

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 50;

// GET /notifications?cursor=<notificationId>&limit=20&unreadOnly=true
const getNotifications = async (req, res) => {
    try {
        const userId = req.user.id;
        const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
        const { cursor } = req.query;
        const unreadOnly = req.query.unreadOnly === "true";

        if (cursor && !OBJECT_ID_REGEX.test(cursor)) {
            return res.status(400).json({ message: "Invalid cursor" });
        }

        const notifications = await prisma.notification.findMany({
            where: {
                recipientId: userId,
                ...(unreadOnly ? { isRead: false } : {}),
            },
            include: notificationInclude,
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: limit + 1,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });

        const hasMore = notifications.length > limit;
        const items = hasMore ? notifications.slice(0, limit) : notifications;
        const unreadCount = await getUnreadCount(userId);

        res.json({
            notifications: items,
            nextCursor: hasMore ? items[items.length - 1].id : null,
            unreadCount,
        });
    } catch (err) {
        res.status(500).json({ message: "Internal Server Error", error: err.message });
    }
};

const getUnreadNotificationCount = async (req, res) => {
    try {
        const unreadCount = await getUnreadCount(req.user.id);
        res.json({ unreadCount });
    } catch (err) {
        res.status(500).json({ message: "Internal Server Error", error: err.message });
    }
};

const markNotificationRead = async (req, res) => {
    try {
        const userId = req.user.id;
        const { notificationId } = req.params;

        if (!OBJECT_ID_REGEX.test(notificationId)) {
            return res.status(400).json({ message: "Invalid notification ID" });
        }

        const { count } = await prisma.notification.updateMany({
            where: { id: notificationId, recipientId: userId, isRead: false },
            data: { isRead: true, readAt: new Date() },
        });

        if (count === 0) {
            const exists = await prisma.notification.findFirst({
                where: { id: notificationId, recipientId: userId },
                select: { id: true },
            });
            if (!exists) return res.status(404).json({ message: "Notification not found" });
        }

        const unreadCount = await pushUnreadCount(userId);
        res.json({ message: "Notification marked as read", unreadCount });
    } catch (err) {
        res.status(500).json({ message: "Internal Server Error", error: err.message });
    }
};

const markAllNotificationsRead = async (req, res) => {
    try {
        const userId = req.user.id;
        const { count } = await prisma.notification.updateMany({
            where: { recipientId: userId, isRead: false },
            data: { isRead: true, readAt: new Date() },
        });

        const unreadCount = await pushUnreadCount(userId);
        res.json({ message: "All notifications marked as read", updated: count, unreadCount });
    } catch (err) {
        res.status(500).json({ message: "Internal Server Error", error: err.message });
    }
};

const deleteNotification = async (req, res) => {
    try {
        const userId = req.user.id;
        const { notificationId } = req.params;

        if (!OBJECT_ID_REGEX.test(notificationId)) {
            return res.status(400).json({ message: "Invalid notification ID" });
        }

        const { count } = await prisma.notification.deleteMany({
            where: { id: notificationId, recipientId: userId },
        });

        if (count === 0) {
            return res.status(404).json({ message: "Notification not found" });
        }

        const unreadCount = await pushUnreadCount(userId);
        res.json({ message: "Notification deleted", unreadCount });
    } catch (err) {
        res.status(500).json({ message: "Internal Server Error", error: err.message });
    }
};

module.exports = {
    getNotifications,
    getUnreadNotificationCount,
    markNotificationRead,
    markAllNotificationsRead,
    deleteNotification,
};
