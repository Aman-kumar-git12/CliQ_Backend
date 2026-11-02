const SocketIO = require("socket.io");
const { prisma } = require("../../prisma/prismaClient");
const redisClient = require("../config/redisClient");
const { config } = require("../config");
const logger = require("../utils/logger");
const { isTokenCurrent, verifyAuthToken } = require("../utils/auth/authUtils");

let io;

// Every socket joins its user's private room so server code can push
// events (e.g. notifications) to all of that user's open tabs.
const getUserRoom = (userId) => `user:${userId}`;

const getAllowedOrigins = () => config.frontendOrigins;

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const MAX_MESSAGE_CHARS = 5000;
const MAX_URL_CHARS = 2048;

const isObjectId = (value) => typeof value === "string" && OBJECT_ID_REGEX.test(value);
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Both users of a one-to-one chat share this room
const getChatRoom = (userId, otherUserId) => [userId, otherUserId].sort().join("_");

const optionalString = (value, max) => {
    if (value === undefined || value === null || value === "") return { value: null };
    if (typeof value !== "string" || value.length > max) return { invalid: true };
    return { value };
};

// Checks a sendMessage payload the way validate() checks a request body
const parseOutgoingMessage = (payload) => {
    if (!isObjectId(payload.targetuserId)) return { error: "Missing or invalid recipient" };
    const text = optionalString(payload.text, MAX_MESSAGE_CHARS);
    const image = optionalString(payload.image, MAX_URL_CHARS);
    const file = optionalString(payload.file, MAX_URL_CHARS);
    const originalName = optionalString(payload.originalName, 255);
    if (text.invalid) return { error: `Messages can be at most ${MAX_MESSAGE_CHARS} characters` };
    if (image.invalid || file.invalid || originalName.invalid) return { error: "Invalid attachment" };
    if (!text.value?.trim() && !image.value && !file.value) return { error: "Message is empty" };
    const parentMessageId = payload.parentMessageId ?? null;
    if (parentMessageId !== null && !isObjectId(parentMessageId)) return { error: "Invalid reply" };
    return {
        targetuserId: payload.targetuserId,
        text: text.value,
        image: image.value,
        file: file.value,
        originalName: originalName.value,
        parentMessageId,
    };
};

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

    let decoded;
    try {
        decoded = verifyAuthToken(token);
    } catch (err) {
        // The client renews its session on this exact message and reconnects
        throw new Error(err.code === "TOKEN_EXPIRED" ? "TOKEN_EXPIRED" : "Authentication failed");
    }
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

// ── Presence ─────────────────────────────────────────────────────────────────
// A user is online while any of their sockets is connected (the app keeps one open on every page, not only in
// chats). Status lives in the Redis hash "userStatus" ("online" or the last-seen time in ms as a string), with
// this process's memory as the fallback when Redis is down. Changes are broadcast as
// statusUpdate { userId, status }.
const presenceFallback = new Map();

const setPresence = async (userId, status) => {
    presenceFallback.set(userId, status);
    try {
        if (await redisClient.ensureReady()) await redisClient.hSet("userStatus", userId, status);
    } catch (err) {
        logger.error("[SOCKET] Saving presence failed:", err.message);
    }
    io.emit("statusUpdate", { userId, status });
};

const getPresence = async (userId) => {
    try {
        if (await redisClient.ensureReady()) {
            const status = await redisClient.hGet("userStatus", userId);
            if (status) return status;
        }
    } catch (err) {
        logger.error("[SOCKET] Reading presence failed:", err.message);
    }
    return presenceFallback.get(userId) || null;
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

    io.on("connection", (socket) => {
        logger.info("user connected socketId: ", socket.id);

        const currentUser = socket.data.user;
        const currentUserId = currentUser.id;
        socket.join(getUserRoom(currentUserId));

        // Every handler goes through on(): a malformed payload or a failing query is logged and answered,
        // never left as an unhandled rejection (which would restart the whole server)
        const on = (event, handler) =>
            socket.on(event, async (payload, ...rest) => {
                const ack = rest.find((arg) => typeof arg === "function");
                try {
                    await handler(isPlainObject(payload) ? payload : {}, ack);
                } catch (err) {
                    logger.error(`[SOCKET] ${event} failed:`, err);
                    ack?.({ success: false, error: "Something went wrong" });
                }
            });

        // Online from the moment any socket connects; userConnected (sent when a chat opens) is kept for
        // older clients and simply repeats it
        setPresence(currentUserId, "online").catch((err) => logger.error("[SOCKET] Presence failed:", err));
        on("userConnected", () => setPresence(currentUserId, "online"));

        on("checkStatus", async ({ userId }, ack) => {
            if (!isObjectId(userId)) return;
            const status = await getPresence(userId);
            if (ack) {
                ack({ userId, status });
            } else {
                socket.emit("statusUpdate", { userId, status });
            }
        });

        socket.on("disconnect", async () => {
            logger.info("user disconnected socketId: ", socket.id);
            try {
                // Another tab (or the always-on notification socket) is still connected.
                const remainingSockets = await io.in(getUserRoom(currentUserId)).fetchSockets();
                if (remainingSockets.length > 0) return;
                await setPresence(currentUserId, Date.now().toString());
            } catch (e) {
                logger.error("[SOCKET] Marking user offline failed:", e);
            }
        });

        // The room name always contains the caller's own id, so a user can only join their own chats
        on("joinChat", ({ targetuserId }) => {
            if (!isObjectId(targetuserId)) {
                logger.warn("joinChat: Missing or invalid targetuserId");
                return;
            }
            const roomId = getChatRoom(currentUserId, targetuserId);
            logger.debug(`[SOCKET] User ${currentUserId} (${socket.id}) joining room: ${roomId}`);
            socket.join(roomId);
        });

        // The frontend keeps one socket for the whole session, so it leaves a chat's room when the chat closes
        on("leaveChat", ({ targetuserId }) => {
            if (!isObjectId(targetuserId)) return;
            socket.leave(getChatRoom(currentUserId, targetuserId));
        });

        on("sendMessage", async (payload, ack) => {
            const reply = (result) => ack?.(result);
            const message = parseOutgoingMessage(payload);
            if (message.error) {
                logger.warn(`sendMessage: ${message.error}`);
                return reply({ success: false, error: message.error });
            }
            const { targetuserId, text, image, file, originalName, parentMessageId } = message;
            if (targetuserId === currentUserId) return reply({ success: false, error: "Recipient unavailable" });

            const roomId = getChatRoom(currentUserId, targetuserId);
            logger.debug(`sendMessage: ${currentUserId} to room ${roomId}`); // never log message text: it is private

            // Independent lookups, so one round trip instead of three
            const [targetUser, connection, existingConversation] = await Promise.all([
                prisma.users.findUnique({ where: { id: targetuserId }, select: { id: true, isBlocked: true } }),
                // Only connected users may message each other
                prisma.connectionsRequest.findFirst({
                    where: {
                        status: "accepted",
                        OR: [
                            { fromUserId: currentUserId, toUserId: targetuserId },
                            { fromUserId: targetuserId, toUserId: currentUserId },
                        ],
                    },
                    select: { id: true },
                }),
                prisma.conversation.findFirst({
                    where: { isGroup: false, participantIds: { hasEvery: [currentUserId, targetuserId] } },
                    orderBy: { updatedAt: "desc" },
                    select: { id: true },
                }),
            ]);

            if (!targetUser || targetUser.isBlocked) {
                return reply({ success: false, error: "Recipient unavailable" });
            }
            if (!connection) {
                return reply({ success: false, error: "You can only message your connections" });
            }

            const conversation =
                existingConversation ||
                (await prisma.conversation.create({
                    data: {
                        isGroup: false,
                        participantIds: [currentUserId, targetuserId],
                        participants: { connect: [{ id: currentUserId }, { id: targetuserId }] },
                    },
                    select: { id: true },
                }));

            // A reply may only quote a message from this same conversation (otherwise any message id
            // would leak that message's text into this chat)
            if (parentMessageId) {
                const parent = await prisma.message.findFirst({
                    where: { id: parentMessageId, conversationId: conversation.id },
                    select: { id: true },
                });
                if (!parent) return reply({ success: false, error: "The message you replied to is not in this chat" });
            }

            const savedMessage = await prisma.message.create({
                data: {
                    text,
                    image,
                    file,
                    originalName,
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
                text,
                image: savedMessage.image,
                file: savedMessage.file,
                originalName: savedMessage.originalName,
                createdAt: savedMessage.createdAt,
                parentMessage: savedMessage.parentMessage
                    ? {
                          id: savedMessage.parentMessage.id,
                          text: savedMessage.parentMessage.isDelete
                              ? "This message is deleted"
                              : savedMessage.parentMessage.text,
                          firstname: savedMessage.parentMessage.sender.firstname,
                      }
                    : null,
            });

            // Acknowledge to sender
            return reply({ success: true, id: savedMessage.id });
        });
    });
};
const getIO = () => {
    if (!io) {
        throw new Error("Socket.io is not initialized!");
    }
    return io;
};
module.exports = { initialiseSocket, getIO, getUserRoom, getChatRoom, parseOutgoingMessage };
