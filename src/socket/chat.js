const express = require("express");
const chatRoutes = express.Router();
const { userAuth } = require("../userConnection/auth");
const { prisma } = require("../../prisma/prismaClient");

// Get chat history with a specific user
chatRoutes.get("/chat/history/:targetUserId", userAuth, async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const targetUserId = req.params.targetUserId;

        // Find the conversation shared by both users
        const conversation = await prisma.conversation.findFirst({
            where: {
                isGroup: false,
                participantIds: {
                    hasEvery: [loggedInUserId, targetUserId]
                }
            },
            include: {
                messages: {
                    orderBy: {
                        createdAt: "asc"
                    }
                }
            }
        });
        if (!conversation) {
            return res.json([]); // No chat history found
        }

        // Mask deleted messages
        const messages = conversation.messages.map(msg => ({
            ...msg,
            text: msg.isDelete ? "This message is deleted" : msg.text
        }));

        res.json(messages);
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
});



const { getIO } = require("./socket");

// Helper to determine Room ID (Consistent with socket.js)
const getRoomId = (conversation) => {
    if (conversation.isGroup) {
        return conversation.id;
    }
    // For pair chat, participantIds should be sorted and joined
    // Ideally we validation check participantIds length > 0
    return conversation.participantIds.sort().join("_");
};

// Start of DELETE endpoint logic
chatRoutes.delete("/chat/message/:messageId", userAuth, async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const { messageId } = req.params;

        // 1. Find message AND its conversation
        const message = await prisma.message.findUnique({
            where: { id: messageId },
            include: { conversation: true }
        });

        if (!message) {
            return res.status(404).json({ message: "Message not found" });
        }

        if (message.senderId !== loggedInUserId) {
            return res.status(401).json({ message: "You can delete only your own message" });
        }

        // 2. Soft Delete
        const updatedMessage = await prisma.message.update({
            where: { id: messageId },
            data: {
                isDelete: true,
                updatedAt: new Date()
            }
        });

        // 3. Real-time update
        try {
            const io = getIO();
            const conversation = message.conversation;
            const roomId = getRoomId(conversation);

            io.to(roomId).emit("messageDeleted", {
                messageId,
                conversationId: conversation.id
            });
        } catch (socketError) {
            // Log but don't fail the request
            console.error("Socket emit failed (messageDeleted):", socketError.message);
        }

        res.json({
            success: true,
            message: "Message deleted successfully",
            data: { ...updatedMessage, text: "This message is deleted" }
        });

    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
});

// Start of PUT endpoint logic
chatRoutes.put("/chat/message/:messageId", userAuth, async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const { messageId } = req.params;
        const { text } = req.body;

        if (!text || !text.trim()) {
            return res.status(400).json({ message: "Message text is required" });
        }

        // 1. Find message AND its conversation
        const message = await prisma.message.findUnique({
            where: { id: messageId },
            include: { conversation: true }
        });

        if (!message) {
            return res.status(404).json({ message: "Message not found" });
        }

        if (message.senderId !== loggedInUserId) {
            return res.status(401).json({ message: "You can edit only your own message" });
        }

        // 2. Update Message
        const updatedMessage = await prisma.message.update({
            where: { id: messageId },
            data: {
                text,
                updatedAt: new Date()
            }
        });

        // 3. Real-time Update
        try {
            const io = getIO();
            const conversation = message.conversation;
            const roomId = getRoomId(conversation);

            io.to(roomId).emit("messageUpdated", {
                messageId,
                text,
                conversationId: conversation.id
            });
        } catch (socketError) {
            console.error("Socket emit failed (messageUpdated):", socketError.message);
        }

        res.json({
            success: true,
            message: "Message updated successfully",
            data: updatedMessage
        });

    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
});

module.exports = { chatRoutes };
