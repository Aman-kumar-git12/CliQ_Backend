const { prisma } = require("../../../prisma/prismaClient");
const { safeUserSelect } = require("../../utils/auth/authUtils");

const getRequests = async (req, res) => {
    const loggedInUser = req.user;
    const connectionRequests = await prisma.connectionsRequest.findMany({
        where: {
            status: "interested",
            toUserId: loggedInUser.id,
        },
        include: {
            fromUser: {
                select: {
                    id: true,
                    firstname: true,
                    lastname: true,
                    imageUrl: true,
                    expertise: true,
                },
            },
        },
    });
    res.json({ message: "Requests successfully fetched", connectionRequests });
};

const getConnections = async (req, res) => {
    const loggedInUser = req.user;
    const connections = await prisma.connectionsRequest.findMany({
        where: {
            status: "accepted",
            OR: [{ fromUserId: loggedInUser.id }, { toUserId: loggedInUser.id }],
        },
        include: {
            fromUser: {
                select: {
                    id: true,
                    firstname: true,
                    lastname: true,
                    imageUrl: true,
                },
            },
            toUser: {
                select: {
                    id: true,
                    firstname: true,
                    lastname: true,
                    imageUrl: true,
                },
            },
        },
    });

    const connectedUsers = connections.map((conn) => {
        return conn.fromUserId === loggedInUser.id ? conn.toUser : conn.fromUser;
    });

    res.json({ message: "Connections successfully fetched", connections: connectedUsers });
};

const cancelRequest = async (req, res) => {
    const loggedInUserId = req.user.id;
    const toUserId = req.params.toUserId;

    const connection = await prisma.connectionsRequest.findFirst({
        where: {
            fromUserId: loggedInUserId,
            toUserId: toUserId,
            status: "interested",
        },
    });

    if (!connection) {
        return res.status(403).json({
            message: "You cannot cancel this request because you did not send it or it is not active.",
        });
    }

    await prisma.connectionsRequest.delete({
        where: { id: connection.id },
    });

    return res.json({ message: "Connection request cancelled successfully." });
};

const unfriend = async (req, res) => {
    const loggedInUser = req.user.id;
    const otherUserId = req.params.otherUserId;

    const connection = await prisma.connectionsRequest.findFirst({
        where: {
            status: "accepted",
            OR: [
                { fromUserId: loggedInUser, toUserId: otherUserId },
                { fromUserId: otherUserId, toUserId: loggedInUser },
            ],
        },
    });

    if (!connection) {
        return res.status(404).json({ message: "No accepted connection found to remove" });
    }

    await prisma.connectionsRequest.delete({
        where: { id: connection.id },
    });

    res.json({ message: "Connection removed successfully" });
};

// Errors reach the error handler (500 without internals) instead of a 400 that echoed the database error
const getFeed = async (req, res) => {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
    const skip = (page - 1) * limit;

    const loggedInUser = req.user;

    const connectionRequests = await prisma.connectionsRequest.findMany({
        where: {
            OR: [{ fromUserId: loggedInUser.id }, { toUserId: loggedInUser.id }],
        },
        select: {
            fromUserId: true,
            toUserId: true,
        },
    });

    const hideUserFromFeed = new Set();
    connectionRequests.forEach((request) => {
        hideUserFromFeed.add(request.fromUserId);
        hideUserFromFeed.add(request.toUserId);
    });
    hideUserFromFeed.add(loggedInUser.id);

    const users = await prisma.users.findMany({
        where: {
            id: {
                notIn: Array.from(hideUserFromFeed),
            },
        },
        select: {
            id: true,
            firstname: true,
            lastname: true,
            age: true,
        },
        skip: skip,
        take: limit,
    });

    res.json({ data: users });
};

const getPublicUserConnections = async (req, res) => {
    const { userId } = req.params;

    const connections = await prisma.connectionsRequest.findMany({
        where: {
            status: "accepted",
            OR: [{ fromUserId: userId }, { toUserId: userId }],
        },
        include: {
            fromUser: {
                select: {
                    id: true,
                    firstname: true,
                    lastname: true,
                    imageUrl: true,
                    expertise: true,
                },
            },
            toUser: {
                select: {
                    id: true,
                    firstname: true,
                    lastname: true,
                    imageUrl: true,
                    expertise: true,
                },
            },
        },
    });

    const connectedUsers = connections.map((conn) => {
        return conn.fromUserId === userId ? conn.toUser : conn.fromUser;
    });

    res.json({ message: "Public connections successfully fetched", connections: connectedUsers });
};

const getAllUsers = async (req, res) => {
    const users = await prisma.users.findMany({
        select: safeUserSelect,
    });
    res.json(users);
};

module.exports = {
    getRequests,
    getConnections,
    cancelRequest,
    unfriend,
    getFeed,
    getPublicUserConnections,
    getAllUsers,
};
