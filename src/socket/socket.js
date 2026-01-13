const SocketIO = require("socket.io")
const { prisma } = require("../../prisma/prismaClient");

let io;

const initialiseSocket = (server) => {

    io = SocketIO(server, {
        cors: {
            origin: process.env.FRONTEND_URL,
        },
    });

    io.on("connection", async (socket) => {
        console.log("user connected socketId: ", socket.id);

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

        socket.on("sendMessage", async ({ firstname, userId, targetuserId, text: newMessage, parentMessageId }, callback) => {
            if (!userId || !targetuserId) {
                console.error("sendMessage: Missing userId or targetuserId");
                return;
            }

            const roomId = [userId, targetuserId].sort().join("_")
            console.log(`sendMessage: ${firstname} to room ${roomId}: ${newMessage}`)

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
                console.log("Found conversation:", conversation?.id)

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
                // Using io.to ensures everyone in the room gets it. 
                // Frontend filters out own messages by senderId.
                io.to(roomId).emit("receiveMessage", {
                    id: savedMessage.id,
                    senderId: userId,
                    firstname: firstname || "User",
                    text: newMessage,
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
