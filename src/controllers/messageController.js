const { prisma } = require("../../prisma/prismaClient");
const { getIO } = require("../socket/socket");
const cloudinary = require("../upload/cloudinary");

const getRoomId = (conversation) => {
    if (conversation.isGroup) return conversation.id;
    return conversation.participantIds.sort().join("_");
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

const uploadFile = async (req, res) => {
    try {
        console.log("Upload request received:", req.file ? {
            originalname: req.file.originalname,
            mimetype: req.file.mimetype,
            size: req.file.size
        } : "No file");

        if (!req.file) return res.status(400).json({ message: "No file provided" });

        const isImage = req.file.mimetype.startsWith("image/");
        const isAudio = req.file.mimetype.startsWith("audio/") || req.file.originalname.endsWith(".webm");

        const folder = isImage ? "chat/images" : "chat/files";

        const uploadPromise = new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                {
                    folder,
                    resource_type: isImage ? "image" : (isAudio ? "video" : "auto"),
                },
                (error, result) => {
                    if (error) {
                        console.error("Cloudinary Stream Error:", error);
                        reject(error);
                    } else {
                        resolve(result);
                    }
                }
            );
            stream.end(req.file.buffer);
        });

        const result = await uploadPromise;
        console.log("Upload result:", result.secure_url);

        res.json({
            url: result.secure_url,
            type: isImage ? "image" : "file",
            originalName: req.file.originalname
        });
    } catch (error) {
        console.error("Chat Upload Error Detail:", error);
        res.status(500).json({
            message: "Upload failed",
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
};

const deleteMessagesBulk = async (req, res) => {
    try {
        const loggedInUserId = req.user.id;
        const { messageIds, deleteType } = req.body;

        if (!Array.isArray(messageIds) || messageIds.length === 0) {
            return res.status(400).json({ message: "No message IDs provided" });
        }

        for (const id of messageIds) {
            try {
                const message = await prisma.message.findUnique({ 
                    where: { id },
                    include: { conversation: true }
                });
                if (!message) continue;

                if (deleteType === 'everyone' && message.senderId === loggedInUserId) {
                    await prisma.message.update({
                        where: { id },
                        data: { isDelete: true }
                    });

                    try {
                        const io = getIO();
                        const roomId = getRoomId(message.conversation);
                        io.to(roomId).emit("messageDeleted", { 
                            messageId: id, 
                            conversationId: message.conversationId 
                        });
                    } catch (socketErr) {
                        console.error(`Socket emit failed for bulk delete message ${id}:`, socketErr.message);
                    }
                } else {
                    if (!message.deletedById.includes(loggedInUserId)) {
                        await prisma.message.update({
                            where: { id },
                            data: { deletedById: { push: loggedInUserId } }
                        });
                    }
                }
            } catch (innerError) {
                console.warn(`Failed to process bulk delete for message ${id}:`, innerError.message);
            }
        }

        return res.json({
            success: true,
            message: deleteType === 'everyone' ? "Bulk delete for everyone processed" : "Bulk delete for me processed"
        });
    } catch (err) {
        console.error("Bulk Delete Error:", err);
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

module.exports = {
    deleteMessage,
    updateMessage,
    uploadFile,
    deleteMessagesBulk
};
