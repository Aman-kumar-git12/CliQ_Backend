const express = require("express");
const chatRoutes = express.Router();
const { userAuth } = require("../auth/middleware");
const { prisma } = require("../../prisma/prismaClient");

// Get all conversations and connections for the logged in user
chatRoutes.get("/chat/conversations", userAuth, async (req, res) => {
    try {
        const loggedInUserId = req.user.id;

        // 1. Fetch existing conversations
        const conversations = await prisma.conversation.findMany({
            where: {
                participantIds: {
                    has: loggedInUserId
                }
            },
            include: {
                participants: {
                    select: {
                        id: true,
                        firstname: true,
                        lastname: true,
                        imageUrl: true
                    }
                },
                messages: {
                    where: {
                        NOT: {
                            deletedById: {
                                has: loggedInUserId
                            }
                        }
                    },
                    orderBy: {
                        createdAt: "desc"
                    },
                    take: 1
                }
            },
            orderBy: {
                updatedAt: "desc"
            }
        });

        // 2. Fetch all accepted connections
        const connections = await prisma.connectionsRequest.findMany({
            where: {
                status: "accepted",
                OR: [{ fromUserId: loggedInUserId }, { toUserId: loggedInUserId }],
            },
            include: {
                fromUser: {
                    select: { id: true, firstname: true, lastname: true, imageUrl: true }
                },
                toUser: {
                    select: { id: true, firstname: true, lastname: true, imageUrl: true }
                }
            }
        });

        // 3. Map conversations to a common format
        const existingChatUserIds = new Set();
        const formattedConversations = conversations.map(conv => {
            const lastMessage = conv.messages[0];

            // ROBUST PARTICIPANT FINDER:
            // Find the participant who is NOT the logged-in user.
            // If it's a self-chat (rare), fallback to first participant.
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

        // 4. Add connections that don't have a conversation yet
        connections.forEach(conn => {
            const otherUser = conn.fromUserId === loggedInUserId ? conn.toUser : conn.fromUser;

            if (!existingChatUserIds.has(otherUser.id)) {
                formattedConversations.push({
                    id: `new_${otherUser.id}`, // Temporary ID for list rendering
                    targetUserId: otherUser.id,
                    name: `${otherUser.firstname || "User"} ${otherUser.lastname || ""}`.trim(),
                    imageUrl: otherUser.imageUrl,
                    lastMessage: "Start a new chat",
                    lastMessageTime: conn.updatedAt,
                    unread: false
                });
            }
        });

        // Sort by time
        formattedConversations.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));

        res.json(formattedConversations);
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
});

// Get chat history with a specific user
chatRoutes.get("/chat/history/:targetuserId", userAuth, async (req, res) => {
    try {
        const userId = req.user.id;
        const targetuserId = req.params.targetuserId;

        console.log(userId, targetuserId)
        const conversation = await prisma.conversation.findFirst({
            where: {
                isGroup: false,
                participantIds: {
                    hasEvery: [userId, targetuserId]
                }
            }
        });

        if (!conversation) {
            return res.json([]);
        }

        // 2. Fetch messages respecting delete rules
        const messages = await prisma.message.findMany({
            where: {
                conversationId: conversation.id,
                NOT: {
                    deletedById: {
                        has: userId
                    }
                }
            },
            orderBy: {
                createdAt: "asc"
            },
            include: {
                parentMessage: {
                    include: {
                        sender: {
                            select: { firstname: true }
                        }
                    }
                }
            }
        });
        console.log("Messages:", messages);
        // 3. Format for frontend
        const formatted = messages.map(msg => ({
            ...msg,

            // Delete-for-everyone masking
            text: msg.isDelete ? "This message is deleted" : msg.text,

            // Identify sender
            isMe: msg.senderId === userId,

            // Reply data
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
        console.error("Chat history error:", err);
        res.status(500).json({ message: "Internal server error" });
    }
});



const { getIO } = require("./socket");
const { isEmpty } = require("validator");

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
// Start of DELETE endpoint logic
chatRoutes.delete("/chat/message/:messageId", userAuth, async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const { messageId } = req.params;

        // Validation for ObjectID (simple 24 char hex check)
        if (!/^[0-9a-fA-F]{24}$/.test(messageId)) {
            return res.status(400).json({ message: "Invalid message ID format" });
        }

        // 1. Find message AND its conversation
        const message = await prisma.message.findUnique({
            where: { id: messageId },
            include: { conversation: true }
        });

        if (!message) {
            return res.status(404).json({ message: "Message not found" });
        }

        // Delete for me (hide)
        await prisma.message.update({
            where: { id: messageId },
            data: {
                deletedById: {
                    push: loggedInUserId
                }
            }
        });
        return res.json({ success: true, message: "Deleted for me" });

    } catch (err) {
        console.error("Delete message error:", err);
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
});

// Start of PUT endpoint logic
chatRoutes.put("/chat/message/:messageId", userAuth, async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const { messageId } = req.params;
        const { text, isDelete } = req.body;

        if (!/^[0-9a-fA-F]{24}$/.test(messageId)) {
            return res.status(400).json({ message: "Invalid message ID format" });
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

        if (isDelete) {
            console.log(`[PUT] Delete request received for message: ${messageId}`, req.body);

            // SOFT DELETE (Delete for everyone)
            const updatedMessage = await prisma.message.update({
                where: { id: messageId },
                data: {
                    isDelete: true,
                    updatedAt: new Date()
                }
            });
            console.log(`[PUT] DB Updated isDelete=true`);

            // Real-time Update for Deletion
            try {
                const io = getIO();
                const roomId = getRoomId(message.conversation);
                console.log(`[PUT-DELETE] Emitting messageDeleted to room: ${roomId} for message: ${messageId}`);
                console.log(`[PUT-DELETE] Participants: ${message.conversation.participantIds}`);

                io.to(roomId).emit("messageDeleted", { messageId, conversationId: message.conversationId });
                console.log(`[PUT-DELETE] Emit called successfully`);
            } catch (e) {
                console.error("Socket emit failed (messageDeleted via PUT):", e);
            }

            return res.json({
                success: true,
                message: "Message deleted for everyone",
                data: updatedMessage
            });

        } else {
            // EDIT MESSAGE
            if (!text || !text.trim()) {
                return res.status(400).json({ message: "Message text is required" });
            }

            const updatedMessage = await prisma.message.update({
                where: { id: messageId },
                data: {
                    text,
                    updatedAt: new Date()
                }
            });

            // Real-time Update for Edit
            try {
                const io = getIO();
                const conversation = message.conversation;
                const roomId = getRoomId(conversation);

                console.log(`[PUT] Emitting messageUpdated to room: ${roomId}`, {
                    messageId,
                    text,
                    conversationId: conversation.id
                });

                io.to(roomId).emit("messageUpdated", {
                    messageId,
                    text,
                    conversationId: conversation.id
                });
            } catch (socketError) {
                console.error("Socket emit failed (messageUpdated):", socketError.message);
            }

            return res.json({
                success: true,
                message: "Message updated successfully",
                data: updatedMessage
            });
        }

    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
});

// Hide/Delete conversation for the logged-in user
chatRoutes.delete("/chat/conversation/:targetUserId", userAuth, async (req, res) => {
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

        if (!conversation) {
            return res.status(404).json({ message: "Conversation not found" });
        }

        // Add user to deletedByIds if not already there
        if (!conversation.deletedByIds || !conversation.deletedByIds.includes(loggedInUserId)) {
            await prisma.conversation.update({
                where: { id: conversation.id },
                data: {
                    deletedByIds: {
                        push: loggedInUserId
                    }
                }
            });
        }

        res.json({ message: "Conversation hidden successfully" });
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
});

module.exports = { chatRoutes };
