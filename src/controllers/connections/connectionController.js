const { prisma } = require("../../../prisma/prismaClient");
const { createNotification, removeNotifications } = require("../../utils/notifications/notificationUtils");
const logger = require("../../utils/logger");

const {
    invalidateRecommendationCache,
    trackRecommendationEvent,
    getRecommendationSource,
    getRecommendationMetadata,
} = require("../../utils/recommendations");

const getConnectionStatus = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const otherUserId = req.params.userId;

        const connection = await prisma.connectionsRequest.findFirst({
            where: {
                OR: [
                    { fromUserId: loggedInUserId, toUserId: otherUserId },
                    { fromUserId: otherUserId, toUserId: loggedInUserId },
                ],
            },
        });

        if (!connection) {
            return res.json({
                status: "none",
                message: "No connection exists between these users",
            });
        }

        return res.json({
            status: connection.status,
            connection,
        });
    } catch (err) {
        logger.error(`${req.method} ${req.originalUrl} failed:`, err);
        return res.status(500).json({
            message: "Internal Server Error",
        });
    }
};

const deleteRequest = async (req, res) => {
    const loggedInUserId = req.user.id;
    const requestId = req.params.requestId;

    const findRequest = await prisma.connectionsRequest.findUnique({
        where: { id: requestId },
    });

    if (!findRequest || findRequest.toUserId !== loggedInUserId) {
        return res.status(404).json({ message: "Connection request not found" });
    }

    const deleted = await prisma.connectionsRequest.delete({
        where: { id: requestId },
    });

    res.json({ message: "Connection request deleted successfully", deleted });
};

const sendRequest = async (req, res) => {
    try {
        const fromUserId = req.user.id;
        const toUserId = req.params.toUserId;
        const status = req.params.status;
        const source = getRecommendationSource(req);
        const requestMetadata = getRecommendationMetadata(req);
        const trackedAction = status === "interested" ? "interested" : status === "ignored" ? "ignored" : null;

        const toUser = await prisma.users.findUnique({
            where: { id: toUserId },
        });

        if (!toUser) {
            return res.status(404).json({ message: "Recipient user not found" });
        }

        const exists = await prisma.connectionsRequest.findFirst({
            where: {
                OR: [
                    { fromUserId: fromUserId, toUserId: toUserId },
                    { fromUserId: toUserId, toUserId: fromUserId },
                ],
            },
        });

        if (exists) {
            if (exists.status === "ignored") {
                const updated = await prisma.connectionsRequest.update({
                    where: { id: exists.id },
                    data: {
                        fromUserId,
                        toUserId,
                        status,
                        updatedAt: new Date(),
                    },
                });
                if (trackedAction) {
                    await trackRecommendationEvent({
                        userId: fromUserId,
                        candidateUserId: toUserId,
                        action: trackedAction,
                        source: source || "manual_request",
                        metadata: getRecommendationMetadata(req, { requestId: updated.id, resent: true }),
                    });
                }
                if (status === "interested") {
                    await createNotification({
                        recipientId: toUserId,
                        actorId: fromUserId,
                        type: "connection_request",
                        connectionRequestId: updated.id,
                    });
                }
                await invalidateRecommendationCache(fromUserId, toUserId);
                return res.json({
                    message: status === "ignored" ? "User ignored" : "Request sent (resend after ignored)",
                    data: updated,
                });
            }
            return res.status(409).json({ message: "Connection already exists", existing: exists });
        }

        const data = await prisma.connectionsRequest.create({
            data: {
                fromUserId,
                toUserId,
                status,
            },
        });

        if (trackedAction) {
            await trackRecommendationEvent({
                userId: fromUserId,
                candidateUserId: toUserId,
                action: trackedAction,
                source: source || "manual_request",
                metadata: {
                    ...requestMetadata,
                    requestId: data.id,
                },
            });
        }

        if (status === "interested") {
            await createNotification({
                recipientId: toUserId,
                actorId: fromUserId,
                type: "connection_request",
                connectionRequestId: data.id,
            });
        }

        await invalidateRecommendationCache(fromUserId, toUserId);

        return res.json({
            message: status === "ignored" ? "User ignored" : "Request sent successfully",
            data,
        });
    } catch (err) {
        logger.error(`${req.method} ${req.originalUrl} failed:`, err);
        if (err?.code === "P2002") {
            return res.status(409).json({ message: "Connection already exists" });
        }
        return res.status(500).json({ message: "Internal server error" });
    }
};

const reviewRequest = async (req, res) => {
    const { status, requestId } = req.params;
    const loggedInUserId = req.user.id;

    const findConnections = await prisma.connectionsRequest.findUnique({
        where: { id: requestId },
    });

    if (!findConnections || findConnections.toUserId !== loggedInUserId) {
        return res.status(404).json({ message: "Connection request not found" });
    }

    if (findConnections.status !== "interested") {
        return res.status(409).json({ message: `Request has already been ${findConnections.status}` });
    }

    const data = await prisma.connectionsRequest.update({
        where: { id: requestId },
        data: { status },
    });

    // The request has been handled, so its "wants to connect" alert is obsolete.
    await removeNotifications({ type: "connection_request", connectionRequestId: requestId });
    if (status === "accepted") {
        await createNotification({
            recipientId: data.fromUserId,
            actorId: loggedInUserId,
            type: "connection_accepted",
            connectionRequestId: data.id,
        });
    }

    await invalidateRecommendationCache(data.fromUserId, data.toUserId);

    res.json({ message: "Connections Reviewed Successfully", data });
};

module.exports = {
    getConnectionStatus,
    deleteRequest,
    sendRequest,
    reviewRequest,
};
