const SocketIO = require("socket.io");
const jwt = require("jsonwebtoken");
const { prisma } = require("../../prisma/prismaClient");
const redisClient = require("../config/redisClient");
const { config } = require("../config");
const logger = require("../utils/logger");
const { isTokenCurrent } = require("../utils/auth/authUtils");

let io;

// Every socket joins its user's private room so server code can push
// events (e.g. notifications) to all of that user's open tabs.
const getUserRoom = (userId) => `user:${userId}`;

const getAllowedOrigins = () => config.frontendOrigins;

const parseCookies = (cookieHeader = "") =>
    String(cookieHeader || "")
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean)
        .reduce((acc, part) => {
            const separatorIndex = part.indexOf("=");
            if (separatorIndex === -1) return acc;

            const key = part.slice(0, separatorIndex).trim();
            const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());
            if (key) {
                acc[key] = value;
            }
            return acc;
        }, {});

const authenticateSocket = async (socket) => {
    const cookies = parseCookies(socket.handshake?.headers?.cookie);
    const token = cookies.auth_token;
    if (!token) {
        throw new Error("Authentication required");
    }

    const decoded = jwt.verify(token, config.jwtSecret);
    const user = await prisma.users.findUnique({
        where: { id: decoded.userId },
        select: {
            id: true,
            firstname: true,
            lastname: true,
            isBlocked: true,
            tokenVersion: true,
        },
    });

    if (!user || !isTokenCurrent(decoded, user)) {
        throw new Error("Session ended");
    }

    if (user.isBlocked) {
        throw new Error("Blocked users cannot use chat");
    }

    return user;
};

const initialiseSocket = (server) => {
    io = SocketIO(server, {
        cors: {
            origin: getAllowedOrigins(),
            credentials: true,
        },
    });

    io.use(async (socket, next) => {
        try {
            socket.data.user = await authenticateSocket(socket);
            next();
        } catch (error) {
            next(new Error(error.message || "Authentication failed"));
        }
    });

    io.on("connection", async (socket) => {
        logger.info("user connected socketId: ", socket.id);

        const currentUser = socket.data.user;
        const currentUserId = currentUser.id;
        socket.join(getUserRoom(currentUserId));

        socket.on("userConnected", async () => {
            // Mark online in Redis Hash 'userStatus'
            try {
                await redisClient.ensureReady();
                await redisClient.hSet("userStatus", currentUserId, "online");
                // Broadcast to everyone that this user is online
                io.emit("statusUpdate", { userId: currentUserId, status: "online" });
                logger.info(`User ${currentUserId} marked online`);
            } catch (e) {
                logger.error("Redis Error:", e);
            }
        });

        socket.on("checkStatus", async ({ userId }, callback) => {
            if (!userId) return;
            try {
                await redisClient.ensureReady();
                const status = await redisClient.hGet("userStatus", userId);
                if (callback) {
                    callback({ userId, status: status || null });
                } else {
                    socket.emit("statusUpdate", { userId, status: status || null });
                }
            } catch (e) {
                logger.error("Redis Error:", e);
            }
        });

        socket.on("disconnect", async () => {
            logger.info("user disconnected socketId: ", socket.id);
            if (currentUser) {
                // Another tab (or the always-on notification socket) is still connected.
                const remainingSockets = await io.in(getUserRoom(currentUserId)).fetchSockets();
                if (remainingSockets.length > 0) return;

                const timestamp = Date.now().toString();
                try {
                    await redisClient.ensureReady();
                    await redisClient.hSet("userStatus", currentUserId, timestamp);
                    io.emit("statusUpdate", { userId: currentUserId, status: timestamp });
                    logger.info(`User ${currentUserId} marked offline at ${timestamp}`);
                } catch (e) {
                    logger.error("Redis Error:", e);
                }
            }
        });

        socket.on("joinChat", ({ targetuserId }) => {
            if (!targetuserId) {
                logger.warn("joinChat: Missing targetuserId", { targetuserId });
                return;
            }
            // TODO: Support group chat roomId logic if needed in future
            const roomId = [currentUserId, targetuserId].sort().join("_");
            logger.info(`[SOCKET] User ${currentUser.firstname} (${socket.id}) joining room: ${roomId}`);
            socket.join(roomId);
        });

        socket.on(
            "sendMessage",
            async ({ targetuserId, text: newMessage, image, file, originalName, parentMessageId }, callback) => {
                if (!targetuserId) {
                    logger.error("sendMessage: Missing targetuserId");
                    return;
                }

                const roomId = [currentUserId, targetuserId].sort().join("_");
                logger.debug(`sendMessage: ${currentUser.firstname} to room ${roomId}`); // never log message text: it is private

                try {
                    const targetUser = await prisma.users.findUnique({
                        where: { id: targetuserId },
                        select: { id: true, isBlocked: true },
                    });

                    if (!targetUser || targetUser.isBlocked) {
                        if (callback) callback({ success: false, error: "Recipient unavailable" });
                        return;
                    }

                    // Only connected users may message each other
                    const connection = await prisma.connectionsRequest.findFirst({
                        where: {
                            status: "accepted",
                            OR: [
                                { fromUserId: currentUserId, toUserId: targetuserId },
                                { fromUserId: targetuserId, toUserId: currentUserId },
                            ],
                        },
                        select: { id: true },
                    });
                    if (!connection) {
                        if (callback) callback({ success: false, error: "You can only message your connections" });
                        return;
                    }

                    // Find existing conversation
                    let conversation = await prisma.conversation.findFirst({
                        where: {
                            isGroup: false,
                            participantIds: {
                                hasEvery: [currentUserId, targetuserId],
                            },
                        },
                        orderBy: { updatedAt: "desc" },
                    });

                    // Create new if not exists
                    if (!conversation) {
                        conversation = await prisma.conversation.create({
                            data: {
                                isGroup: false,
                                participantIds: [currentUserId, targetuserId],
                                participants: {
                                    connect: [{ id: currentUserId }, { id: targetuserId }],
                                },
                            },
                        });
                    }
                    // Save message
                    const savedMessage = await prisma.message.create({
                        data: {
                            text: newMessage,
                            image: image || null,
                            file: file || null,
                            originalName: originalName || null,
                            conversationId: conversation.id,
                            senderId: currentUserId,
                            status: "sent",
                            deletedById: [],
                            parentMessageId,
                        },
                        include: {
                            parentMessage: {
                                include: {
                                    sender: {
                                        select: { firstname: true, id: true },
                                    },
                                },
                            },
                        },
                    });

                    // Emit with DB id
                    io.to(roomId).emit("receiveMessage", {
                        id: savedMessage.id,
                        senderId: currentUserId,
                        firstname: currentUser.firstname || "User",
                        text: newMessage,
                        image: savedMessage.image,
                        file: savedMessage.file,
                        originalName: savedMessage.originalName,
                        createdAt: savedMessage.createdAt,
                        parentMessage: savedMessage.parentMessage
                            ? {
                                  id: savedMessage.parentMessage.id,
                                  text: savedMessage.parentMessage.text,
                                  firstname: savedMessage.parentMessage.sender.firstname,
                              }
                            : null,
                    });

                    // Acknowledge to sender
                    if (callback) {
                        callback({ success: true, id: savedMessage.id });
                    }
                } catch (err) {
                    logger.error("Error saving message:", err);
                    if (callback) callback({ success: false });
                }
            },
        );
    });
};
const getIO = () => {
    if (!io) {
        throw new Error("Socket.io is not initialized!");
    }
    return io;
};
module.exports = { initialiseSocket, getIO, getUserRoom };
