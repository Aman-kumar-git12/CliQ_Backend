const { prisma } = require("../../prisma/prismaClient");

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
        return res.status(500).json({
            message: "Internal Server Error",
            error: err.message,
        });
    }
};

const deleteRequest = async (req, res) => {
    try {
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
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const getRandomUser = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;

        const connections = await prisma.connectionsRequest.findMany({
            where: {
                OR: [
                    { toUserId: loggedInUserId },
                    { fromUserId: loggedInUserId },
                ],
            },
            select: {
                fromUserId: true,
                toUserId: true,
            },
        });

        const excludedUserIds = new Set();
        connections.forEach((conn) => {
            excludedUserIds.add(conn.fromUserId);
            excludedUserIds.add(conn.toUserId);
        });
        excludedUserIds.add(loggedInUserId);

        const excludedArray = Array.from(excludedUserIds);

        const count = await prisma.users.count({
            where: {
                id: { notIn: excludedArray },
            },
        });

        if (count === 0) {
            return res.status(404).json({ message: "No random user available" });
        }

        const skip = Math.floor(Math.random() * count);

        const randomUser = await prisma.users.findMany({
            where: {
                id: { notIn: excludedArray },
            },
            skip: skip,
            take: 1,
        });

        res.json(randomUser[0]);
    } catch (err) {
        res.status(500).json({
            message: "Internal Server Error",
            error: err.message,
        });
    }
};

const sendRequest = async (req, res) => {
    try {
        const fromUserId = req.user.id;
        const toUserId = req.params.toUserId;
        const status = req.params.status;

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
                return res.json({ message: "Request sent (resend after ignored)", data: updated });
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

        return res.json({ message: "Request sent successfully", data });
    } catch (err) {
        return res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const reviewRequest = async (req, res) => {
    try {
        const { status, requestId } = req.params;
        const loggedInUserId = req.user.id;

        const findConnections = await prisma.connectionsRequest.findUnique({
            where: { id: requestId },
        });

        if (!findConnections || findConnections.toUserId !== loggedInUserId) {
            return res.status(404).json({ message: "Connection request not found" });
        }

        const data = await prisma.connectionsRequest.update({
            where: { id: requestId },
            data: { status },
        });

        res.json({ message: "Connections Reviewed Successfully", data });
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

module.exports = {
    getConnectionStatus,
    deleteRequest,
    getRandomUser,
    sendRequest,
    reviewRequest
};
