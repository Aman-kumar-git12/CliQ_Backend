const { prisma } = require("../../../prisma/prismaClient");

const userCardSelect = { id: true, firstname: true, lastname: true, imageUrl: true };

// The newest message this user can still see in a conversation
const findLastVisibleMessage = (conversationId, userId) =>
    prisma.message.findFirst({
        where: { conversationId, isDelete: false, NOT: { deletedById: { has: userId } } },
        orderBy: { createdAt: "desc" },
        select: { text: true, image: true, file: true, createdAt: true },
    });

const getConversations = async (req, res) => {
    const loggedInUserId = req.user.id;

    // A nested `messages: { take: 1 }` include would load every message of every conversation and trim
    // them in memory, so the last message is read per conversation instead (one indexed row each, in parallel)
    const [conversationRows, connections] = await Promise.all([
        prisma.conversation.findMany({
            where: { participantIds: { has: loggedInUserId } },
            select: { id: true, updatedAt: true, participants: { select: userCardSelect } },
            orderBy: { updatedAt: "desc" },
        }),
        prisma.connectionsRequest.findMany({
            where: {
                status: "accepted",
                OR: [{ fromUserId: loggedInUserId }, { toUserId: loggedInUserId }],
            },
            select: {
                fromUserId: true,
                updatedAt: true,
                fromUser: { select: userCardSelect },
                toUser: { select: userCardSelect },
            },
        }),
    ]);
    const lastMessages = await Promise.all(
        conversationRows.map((conv) => findLastVisibleMessage(conv.id, loggedInUserId)),
    );
    const conversations = conversationRows.map((conv, i) => ({
        ...conv,
        messages: lastMessages[i] ? [lastMessages[i]] : [],
    }));

    const existingChatUserIds = new Set();
    const formattedConversations = conversations.map((conv) => {
        const lastMessage = conv.messages[0];
        const otherParticipant = conv.participants.find((p) => p.id !== loggedInUserId) || conv.participants[0] || {};
        if (otherParticipant.id) existingChatUserIds.add(otherParticipant.id);

        return {
            id: conv.id,
            targetUserId: otherParticipant.id,
            name: `${otherParticipant.firstname || "User"} ${otherParticipant.lastname || ""}`.trim(),
            imageUrl: otherParticipant.imageUrl,
            lastMessage: lastMessage
                ? lastMessage.text ||
                  (lastMessage.image
                      ? "Image"
                      : lastMessage.file
                        ? lastMessage.file.includes("voice_message")
                            ? "Voice Message"
                            : "File"
                        : "Message")
                : "No messages yet",
            lastMessageTime: lastMessage ? lastMessage.createdAt : conv.updatedAt,
            unread: false,
        };
    });

    connections.forEach((conn) => {
        const otherUser = conn.fromUserId === loggedInUserId ? conn.toUser : conn.fromUser;
        if (!existingChatUserIds.has(otherUser.id)) {
            formattedConversations.push({
                id: `new_${otherUser.id}`,
                targetUserId: otherUser.id,
                name: `${otherUser.firstname || "User"} ${otherUser.lastname || ""}`.trim(),
                imageUrl: otherUser.imageUrl,
                lastMessage: "Start a new chat",
                lastMessageTime: conn.updatedAt,
                unread: false,
            });
        }
    });

    formattedConversations.sort((a, b) => new Date(b.lastMessageTime) - new Date(a.lastMessageTime));
    res.json(formattedConversations);
};

// Messages deleted for everyone keep their row (so replies still point somewhere) but nothing of their content
const DELETED_TEXT = "This message is deleted";

const getChatHistory = async (req, res) => {
    const userId = req.user.id;
    const targetuserId = req.params.targetuserId;

    const conversation = await prisma.conversation.findFirst({
        where: {
            isGroup: false,
            participantIds: { hasEvery: [userId, targetuserId] },
        },
        select: { id: true },
    });

    if (!conversation) return res.json([]);

    const messages = await prisma.message.findMany({
        where: {
            conversationId: conversation.id,
            NOT: { deletedById: { has: userId } },
        },
        orderBy: { createdAt: "asc" },
        include: {
            parentMessage: {
                select: { id: true, text: true, isDelete: true, sender: { select: { firstname: true } } },
            },
        },
    });

    // deletedById lists who hid the message; that's nobody else's business
    const formatted = messages.map(({ deletedById: _hiddenBy, ...msg }) => ({
        ...msg,
        ...(msg.isDelete ? { text: DELETED_TEXT, image: null, file: null, originalName: null } : {}),
        isMe: msg.senderId === userId,
        parentMessage: msg.parentMessage
            ? {
                  id: msg.parentMessage.id,
                  text: msg.parentMessage.isDelete ? DELETED_TEXT : msg.parentMessage.text,
                  firstname: msg.parentMessage.sender.firstname,
              }
            : null,
    }));

    res.json(formatted);
};

const getPublicUserGroups = async (req, res) => {
    const { userId } = req.params;

    const groups = await prisma.conversation.findMany({
        where: {
            isGroup: true,
            participantIds: { has: userId },
        },
        include: {
            participants: {
                select: { id: true, firstname: true, lastname: true, imageUrl: true },
            },
        },
    });

    res.json({ message: "Public groups successfully fetched", groups });
};

module.exports = {
    getConversations,
    getChatHistory,
    getPublicUserGroups,
};
