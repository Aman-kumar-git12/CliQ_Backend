const SocketIO = require("socket.io")
const { prisma } = require("../../prisma/prismaClient");
const redisClient = require("../config/redisClient");

let io;

const initialiseSocket = (server) => {

    io = SocketIO(server, {
        cors: {
            origin: process.env.FRONTEND_URL,
        },
    });

    io.on("connection", async (socket) => {
        console.log("user connected socketId: ", socket.id);

        let currentUser = null; // Store user ID attached to this socket

        socket.on("userConnected", async ({ userId }) => {
            if (!userId) return;
            currentUser = userId;
            // Mark online in Redis Hash 'userStatus'
            try {
                await redisClient.hSet('userStatus', userId, 'online');
                // Broadcast to everyone that this user is online
                io.emit("statusUpdate", { userId, status: 'online' });
                console.log(`User ${userId} marked online`);
            } catch (e) { console.error("Redis Error:", e); }
        });

        socket.on("checkStatus", async ({ userId }, callback) => {
            if (!userId) return;
            try {
                const status = await redisClient.hGet('userStatus', userId);
                if (callback) {
                    callback({ userId, status: status || null });
                } else {
                    socket.emit("statusUpdate", { userId, status: status || null });
                }
            } catch (e) { console.error("Redis Error:", e); }
        });

        socket.on("disconnect", async () => {
            console.log("user disconnected socketId: ", socket.id);
            if (currentUser) {
                const timestamp = Date.now().toString();
                try {
                    await redisClient.hSet('userStatus', currentUser, timestamp);
                    io.emit("statusUpdate", { userId: currentUser, status: timestamp });
                    console.log(`User ${currentUser} marked offline at ${timestamp}`);
                } catch (e) { console.error("Redis Error:", e); }
            }
        });

        socket.on("joinChat", ({ firstname, userId, targetuserId }) => {
            if (!userId || !targetuserId) {
                console.warn("joinChat: Missing userId or targetuserId", { userId, targetuserId });
                return;
            }
            // TODO: Support group chat roomId logic if needed in future
            const roomId = [userId, targetuserId].sort().join("_")
            console.log(`[SOCKET] User ${firstname} (${socket.id}) joining room: ${roomId}`);
            socket.join(roomId)
        })

        socket.on("sendMessage", async ({ firstname, userId, targetuserId, text: newMessage, image, file, originalName, parentMessageId }, callback) => {
            if (!userId || !targetuserId) {
                console.error("sendMessage: Missing userId or targetuserId");
                return;
            }

            const roomId = [userId, targetuserId].sort().join("_")
            console.log(`sendMessage: ${firstname} to room ${roomId}: ${newMessage || "[attachment]"}`)

            try {
                // Find existing conversation
                let conversation = await prisma.conversation.findFirst({
                    where: {
                        isGroup: false,
                        participantIds: {
                            hasEvery: [userId, targetuserId]
                        }
                    },
                    orderBy: { updatedAt: 'desc' }
                });

                // Create new if not exists
                if (!conversation) {
                    conversation = await prisma.conversation.create({
                        data: {
                            isGroup: false,
                            participantIds: [userId, targetuserId],
                            participants: {
                                connect: [{ id: userId }, { id: targetuserId }]
                            }
                        }
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
                        senderId: userId,
                        status: "sent",
                        deletedById: [],
                        parentMessageId
                    },
                    include: {
                        parentMessage: {
                            include: {
                                sender: {
                                    select: { firstname: true, id: true }
                                }
                            }
                        }
                    }
                });

                // Emit with DB id
                io.to(roomId).emit("receiveMessage", {
                    id: savedMessage.id,
                    senderId: userId,
                    firstname: firstname || "User",
                    text: newMessage,
                    image: savedMessage.image,
                    file: savedMessage.file,
                    originalName: savedMessage.originalName,
                    createdAt: savedMessage.createdAt,
                    parentMessage: savedMessage.parentMessage ? {
                        id: savedMessage.parentMessage.id,
                        text: savedMessage.parentMessage.text,
                        firstname: savedMessage.parentMessage.sender.firstname
                    } : null
                });

                // Acknowledge to sender
                if (callback) {
                    callback({ success: true, id: savedMessage.id });
                }

            } catch (err) {
                console.error("Error saving message:", err);
                if (callback) callback({ success: false, error: err.message });
            }
        });

    });

}
const getIO = () => {
    if (!io) {
        throw new Error("Socket.io is not initialized!");
    }
    return io;
}
module.exports = { initialiseSocket, getIO }
