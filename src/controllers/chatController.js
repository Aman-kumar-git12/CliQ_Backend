const { prisma } = require("../../prisma/prismaClient");
const { getIO } = require("../socket/socket"); // Correcting path if needed

const getRoomId = (conversation) => {
    if (conversation.isGroup) return conversation.id;
    return conversation.participantIds.sort().join("_");
};

const getConversations = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;

        const conversations = await prisma.conversation.findMany({
            where: { participantIds: { has: loggedInUserId } },
            include: {
                participants: {
                    select: { id: true, firstname: true, lastname: true, imageUrl: true }
                },
                messages: {
                    where: { NOT: { deletedById: { has: loggedInUserId } } },
                    orderBy: { createdAt: "desc" },
                    take: 1
                }
            },
            orderBy: { updatedAt: "desc" }
        });

        const connections = await prisma.connectionsRequest.findMany({
            where: {
                status: "accepted",
                OR: [{ fromUserId: loggedInUserId }, { toUserId: loggedInUserId }],
            },
            include: {
                fromUser: { select: { id: true, firstname: true, lastname: true, imageUrl: true } },
                toUser: { select: { id: true, firstname: true, lastname: true, imageUrl: true } }
            }
        });

        const existingChatUserIds = new Set();
        const formattedConversations = conversations.map(conv => {
            const lastMessage = conv.messages[0];
            const otherParticipant = conv.participants.find(p => p.id !== loggedInUserId) || conv.participants[0] || {};
            if (otherParticipant.id) existingChatUserIds.add(otherParticipant.id);

            return {
                id: conv.id,
                targetUserId: otherParticipant.id,
                name: `${otherParticipant.firstname || "User"} ${otherParticipant.lastname || ""}`.trim(),
                imageUrl: otherParticipant.imageUrl,
                lastMessage: lastMessage
                    ? (lastMessage.isDelete ? "This message was deleted" : lastMessage.text)
                    : "No messages yet",
                lastMessageTime: lastMessage ? lastMessage.createdAt : conv.updatedAt,
                unread: false
            };
        });

        connections.forEach(conn => {
            const otherUser = conn.fromUserId === loggedInUserId ? conn.toUser : conn.fromUser;
            if (!existingChatUserIds.has(otherUser.id)) {
                formattedConversations.push({
                    id: `new_${otherUser.id}`,
                    targetUserId: otherUser.id,
                    name: `${otherUser.firstname || "User"} ${otherUser.lastname || ""}`.trim(),
                    imageUrl: otherUser.imageUrl,
                    lastMessage: "Start a new chat",
                    lastMessageTime: conn.updatedAt,
                    unread: false
                });
            }
        });

        formattedConversations.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));
        res.json(formattedConversations);
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const getChatHistory = async (req, res) => {
    try {
        const userId = req.user.id;
        const targetuserId = req.params.targetuserId;

        const conversation = await prisma.conversation.findFirst({
            where: {
                isGroup: false,
                participantIds: { hasEvery: [userId, targetuserId] }
            }
        });

        if (!conversation) return res.json([]);

        const messages = await prisma.message.findMany({
            where: {
                conversationId: conversation.id,
                NOT: { deletedById: { has: userId } }
            },
            orderBy: { createdAt: "asc" },
            include: {
                parentMessage: {
                    include: { sender: { select: { firstname: true } } }
                }
            }
        });

        const formatted = messages.map(msg => ({
            ...msg,
            text: msg.isDelete ? "This message is deleted" : msg.text,
            isMe: msg.senderId === userId,
            parentMessage: msg.parentMessage
                ? {
                    id: msg.parentMessage.id,
                    text: msg.parentMessage.text,
                    firstname: msg.parentMessage.sender.firstname
                }
                : null
        }));

        res.json(formatted);
    } catch (err) {
        res.status(500).json({ message: "Internal server error" });
    }
};

const deleteMessage = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const { messageId } = req.params;

        if (!/^[0-9a-fA-F]{24}$/.test(messageId)) {
            return res.status(400).json({ message: "Invalid message ID format" });
        }

        const message = await prisma.message.findUnique({
            where: { id: messageId }
        });

        if (!message) return res.status(404).json({ message: "Message not found" });

        await prisma.message.update({
            where: { id: messageId },
            data: { deletedById: { push: loggedInUserId } }
        });

        return res.json({ success: true, message: "Deleted for me" });
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const updateMessage = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const { messageId } = req.params;
        const { text, isDelete } = req.body;

        if (!/^[0-9a-fA-F]{24}$/.test(messageId)) {
            return res.status(400).json({ message: "Invalid message ID format" });
        }

        const message = await prisma.message.findUnique({
            where: { id: messageId },
            include: { conversation: true }
        });

        if (!message) return res.status(404).json({ message: "Message not found" });
        if (message.senderId !== loggedInUserId) {
            return res.status(401).json({ message: "You can edit only your own message" });
        }

        if (isDelete) {
            const updatedMessage = await prisma.message.update({
                where: { id: messageId },
                data: { isDelete: true, updatedAt: new Date() }
            });

            try {
                const io = getIO();
                const roomId = getRoomId(message.conversation);
                io.to(roomId).emit("messageDeleted", { messageId, conversationId: message.conversationId });
            } catch (e) {
                console.error("Socket emit failed:", e);
            }

            return res.json({ success: true, message: "Message deleted for everyone", data: updatedMessage });
        } else {
            if (!text || !text.trim()) return res.status(400).json({ message: "Message text is required" });

            const updatedMessage = await prisma.message.update({
                where: { id: messageId },
                data: { text, updatedAt: new Date() }
            });

            try {
                const io = getIO();
                const roomId = getRoomId(message.conversation);
                io.to(roomId).emit("messageUpdated", { messageId, text, conversationId: message.conversationId });
            } catch (socketError) {
                console.error("Socket emit failed:", socketError.message);
            }

            return res.json({ success: true, message: "Message updated successfully", data: updatedMessage });
        }
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const hideConversation = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const targetUserId = req.params.targetUserId;

        const conversation = await prisma.conversation.findFirst({
            where: {
                isGroup: false,
                AND: [
                    { participantIds: { has: loggedInUserId } },
                    { participantIds: { has: targetUserId } }
                ]
            }
        });

        if (!conversation) return res.status(404).json({ message: "Conversation not found" });

        if (!conversation.deletedByIds || !conversation.deletedByIds.includes(loggedInUserId)) {
            await prisma.conversation.update({
                where: { id: conversation.id },
                data: { deletedByIds: { push: loggedInUserId } }
            });
        }

        res.json({ message: "Conversation hidden successfully" });
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

module.exports = {
    getConversations,
    getChatHistory,
    deleteMessage,
    updateMessage,
    hideConversation
};
