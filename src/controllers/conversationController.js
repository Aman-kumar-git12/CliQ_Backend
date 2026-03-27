const { prisma } = require("../../prisma/prismaClient");

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
                    where: { 
                        AND: [
                            { NOT: { deletedById: { has: loggedInUserId } } },
                            { isDelete: false }
                        ]
                    },
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
                    ? (lastMessage.text || (lastMessage.image ? "Image" : (lastMessage.file ? (lastMessage.file.includes("voice_message") ? "Voice Message" : "File") : "Message")))
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

const getPublicUserGroups = async (req, res) => {
    try {
        const { userId } = req.params;

        if (!userId || userId.length !== 24 || !/^[0-9a-fA-F]+$/.test(userId)) {
            return res.status(400).json({ message: "Invalid User ID format" });
        }

        const groups = await prisma.conversation.findMany({
            where: {
                isGroup: true,
                participantIds: { has: userId }
            },
            include: {
                participants: {
                    select: { id: true, firstname: true, lastname: true, imageUrl: true }
                }
            }
        });

        res.json({ message: "Public groups successfully fetched", groups });
    } catch (err) {
        res.status(500).json({ message: "Internal Server Error", error: err.message });
    }
};

module.exports = {
    getConversations,
    getChatHistory,
    hideConversation,
    getPublicUserGroups
};
