const { prisma } = require("../../../prisma/prismaClient");
const { getIO } = require("../../socket/socket");
const { uploadBuffer } = require("../../upload/cloudinary");
const logger = require("../../utils/logger");

const getRoomId = (conversation) => {
    if (conversation.isGroup) return conversation.id;
    return [...conversation.participantIds].sort().join("_");
};

// A message the user may act on: it must belong to one of their own conversations
const findOwnConversationMessage = (messageId, userId) =>
    prisma.message.findFirst({
        where: { id: messageId, conversation: { participantIds: { has: userId } } },
        include: { conversation: { select: { id: true, isGroup: true, participantIds: true } } },
    });

const emitToConversation = (conversation, event, payload) => {
    try {
        getIO().to(getRoomId(conversation)).emit(event, payload);
    } catch (e) {
        logger.error("Socket emit failed:", e.message);
    }
};

const deleteMessage = async (req, res) => {
    const loggedInUserId = req.user.id;
    const { messageId } = req.params;

    const message = await findOwnConversationMessage(messageId, loggedInUserId);
    if (!message) return res.status(404).json({ message: "Message not found" });

    if (!message.deletedById.includes(loggedInUserId)) {
        await prisma.message.update({
            where: { id: messageId },
            data: { deletedById: { push: loggedInUserId } },
        });
    }

    return res.json({ success: true, message: "Deleted for me" });
};

const updateMessage = async (req, res) => {
    const loggedInUserId = req.user.id;
    const { messageId } = req.params;
    const { text, isDelete } = req.body;

    const message = await findOwnConversationMessage(messageId, loggedInUserId);

    if (!message) return res.status(404).json({ message: "Message not found" });
    if (message.senderId !== loggedInUserId) {
        return res.status(403).json({ message: "You can edit only your own message" });
    }

    if (isDelete) {
        const updatedMessage = await prisma.message.update({
            where: { id: messageId },
            data: { isDelete: true, updatedAt: new Date() },
        });

        emitToConversation(message.conversation, "messageDeleted", {
            messageId,
            conversationId: message.conversationId,
        });

        return res.json({ success: true, message: "Message deleted for everyone", data: updatedMessage });
    } else {
        if (!text || !text.trim()) return res.status(400).json({ message: "Message text is required" });
        if (message.isDelete) return res.status(409).json({ message: "A deleted message can't be edited" });

        const updatedMessage = await prisma.message.update({
            where: { id: messageId },
            data: { text, updatedAt: new Date() },
        });

        emitToConversation(message.conversation, "messageUpdated", {
            messageId,
            text,
            conversationId: message.conversationId,
        });

        return res.json({ success: true, message: "Message updated successfully", data: updatedMessage });
    }
};

const uploadFile = async (req, res) => {
    if (!req.file) return res.status(400).json({ message: "No file provided" });

    const isImage = req.file.mimetype.startsWith("image/");
    const isAudio = req.file.mimetype.startsWith("audio/") || req.file.originalname.endsWith(".webm");

    const result = await uploadBuffer(req.file, {
        folder: isImage ? "chat/images" : "chat/files",
        resource_type: isImage ? "image" : isAudio ? "video" : "auto",
    });

    res.json({
        url: result.secure_url,
        type: isImage ? "image" : "file",
        originalName: req.file.originalname,
    });
};

const deleteMessagesBulk = async (req, res) => {
    const loggedInUserId = req.user.id;
    const { messageIds, deleteType } = req.body;

    if (!Array.isArray(messageIds) || messageIds.length === 0) {
        return res.status(400).json({ message: "No message IDs provided" });
    }

    // One read and at most two writes for the whole selection, instead of a few queries per message.
    // Only messages in the user's own conversations count; "everyone" applies to the ones they sent.
    const messages = await prisma.message.findMany({
        where: { id: { in: messageIds }, conversation: { participantIds: { has: loggedInUserId } } },
        select: {
            id: true,
            senderId: true,
            deletedById: true,
            conversationId: true,
            conversation: { select: { id: true, isGroup: true, participantIds: true } },
        },
    });

    const forEveryone =
        deleteType === "everyone" ? messages.filter((message) => message.senderId === loggedInUserId) : [];
    const forEveryoneIds = new Set(forEveryone.map((message) => message.id));
    const forMeIds = messages
        .filter((message) => !forEveryoneIds.has(message.id) && !message.deletedById.includes(loggedInUserId))
        .map((message) => message.id);

    await Promise.all([
        forEveryone.length
            ? prisma.message.updateMany({ where: { id: { in: [...forEveryoneIds] } }, data: { isDelete: true } })
            : null,
        forMeIds.length
            ? prisma.message.updateMany({
                  where: { id: { in: forMeIds } },
                  data: { deletedById: { push: loggedInUserId } },
              })
            : null,
    ]);

    for (const message of forEveryone) {
        emitToConversation(message.conversation, "messageDeleted", {
            messageId: message.id,
            conversationId: message.conversationId,
        });
    }

    return res.json({
        success: true,
        message: deleteType === "everyone" ? "Bulk delete for everyone processed" : "Bulk delete for me processed",
    });
};

module.exports = {
    deleteMessage,
    updateMessage,
    uploadFile,
    deleteMessagesBulk,
};
