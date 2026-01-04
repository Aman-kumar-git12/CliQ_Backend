
const socket = require("socket.io")
const { prisma } = require("../../prisma/prismaClient");

let io;

const initialiseSocket = (server) => {

    io = socket(server, {
        cors: {
            origin: process.env.FRONTEND_URL,
        },
    });

    io.on("connection", async (socket) => {
        console.log("user connected");
        socket.on("joinChat", ({ firstname, userId, targetuserId }) => {
            const roomId = [userId, targetuserId].sort().join("_")
            console.log(firstname + " joined room " + roomId)
            socket.join(roomId)
        })



        socket.on("sendMessage", async ({ firstname, userId, targetuserId, text: newMessage }) => {
            const roomId = [userId, targetuserId].sort().join("_")
            console.log(firstname + " : " + newMessage + " " + roomId)

            try {
                // Find existing conversation
                let conversation = await prisma.conversation.findFirst({
                    where: {
                        isGroup: false,
                        participantIds: {
                            hasEvery: [userId, targetuserId]
                        }
                    }
                });
                console.log(conversation)

                // Create new if not exists
                if (!conversation) {
                    conversation = await prisma.conversation.create({
                        data: {
                            isGroup: false,
                            participantIds: [userId, targetuserId]
                        }
                    });
                }

                // Save message
                const savedMessage = await prisma.message.create({
                    data: {
                        text: newMessage,
                        conversationId: conversation.id,
                        senderId: userId,
                        status: "sent"
                    }
                });

                // Emit with DB id (optional, but good practice)
                socket.to(roomId).emit("receiveMessage", {
                    firstname,
                    text: newMessage,
                    createdAt: savedMessage.createdAt
                });

            } catch (err) {
                console.error("Error saving message:", err);
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
