const { prisma } = require("../../../prisma/prismaClient");
const { formatComment } = require("./postUtils");

const addComment = async (req, res) => {
    try {
        const { postId } = req.params;
        const { comment } = req.body;
        const { id } = req.user;
        const newComment = await prisma.comment.create({
            data: { userId: id, postId, comment }
        });
        res.json(newComment);
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const deleteComment = async (req, res) => {
    try {
        const { commentId } = req.params;
        const userId = req.user.id;

        const comment = await prisma.comment.findUnique({ where: { id: commentId } });

        if (!comment) return res.status(404).json({ message: "Comment not found" });
        if (comment.userId !== userId) return res.status(403).json({ message: "Unauthorized" });

        await prisma.comment.delete({ where: { id: commentId } });
        res.json({ message: "Comment deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getCommentsByPostId = async (req, res) => {
    try {
        const { postId } = req.params;
        const currentUserId = req.user.id;

        const comments = await prisma.comment.findMany({
            where: { postId },
            include: {
                user: { select: { firstname: true, lastname: true, imageUrl: true } },
                reports: { where: { userId: currentUserId } }
            },
            orderBy: { createdAt: 'desc' }
        });

        res.json(comments.map(formatComment));
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const createLike = async (req, res) => {
    try {
        const { postId } = req.params;
        const userId = req.user.id;

        if (!/^[0-9a-fA-F]{24}$/.test(postId)) {
            return res.status(400).json({ message: "Invalid Post ID format" });
        }

        const existingLike = await prisma.like.findUnique({
            where: { userId_postId: { userId, postId } }
        });

        if (existingLike) {
            const updatedLike = await prisma.like.update({
                where: { id: existingLike.id },
                data: { isLiked: !existingLike.isLiked }
            });
            return res.json({ message: updatedLike.isLiked ? "Post liked" : "Post unliked", isLiked: updatedLike.isLiked });
        }

        await prisma.like.create({
            data: { userId, postId, isLiked: true }
        });
        return res.json({ message: "Post liked", isLiked: true });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getLikesCount = async (req, res) => {
    try {
        const { postId } = req.params;
        const count = await prisma.like.count({
            where: { postId, isLiked: true }
        });
        res.json({ likesCount: count });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getUsersWhoLikedPost = async (req, res) => {
    try {
        const { postId } = req.params;
        const likes = await prisma.like.findMany({
            where: { postId, isLiked: true },
            include: { user: { select: { id: true, firstname: true, lastname: true, imageUrl: true } } },
            take: 10
        });

        res.json(likes.map(l => ({
            id: l.user.id,
            username: `${l.user.firstname} ${l.user.lastname}`,
            avatar: l.user.imageUrl || "https://github.com/shadcn.png"
        })));
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

module.exports = { addComment, deleteComment, getCommentsByPostId, createLike, getLikesCount, getUsersWhoLikedPost };
