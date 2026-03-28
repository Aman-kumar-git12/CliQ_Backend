const { prisma } = require("../../../prisma/prismaClient");
const cloudinary = require("../../upload/cloudinary");
const { formatPost } = require("./postUtils");

const getPostById = async (req, res) => {
    try {
        const { postId } = req.params;
        const currentUserId = req.user.id;
        
        if (!/^[0-9a-fA-F]{24}$/.test(postId)) {
            return res.status(400).json({ message: "Invalid Post ID format" });
        }

        const post = await prisma.post.findUnique({
            where: { id: postId },
            include: {
                user: { select: { firstname: true, lastname: true, imageUrl: true } },
                _count: { select: { comments: true } },
                likes: { where: { userId: currentUserId } },
                reports: { where: { userId: currentUserId } }
            }
        });

        if (!post) return res.status(404).json({ message: "Post not found" });

        const likesCount = await prisma.like.count({
            where: { postId, isLiked: true }
        });

        res.json(formatPost({ ...post, _count: { ...post._count, likes: likesCount } }, currentUserId));
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const createPost = async (req, res) => {
    try {
        const { content } = req.body;
        let imageUrl = null;

        if (req.file) {
            const uploadPromise = new Promise((resolve, reject) => {
                const stream = cloudinary.uploader.upload_stream(
                    { folder: "posts" },
                    (error, result) => {
                        if (error) reject(error);
                        else resolve(result);
                    }
                );
                stream.end(req.file.buffer);
            });

            const result = await uploadPromise;
            imageUrl = result.secure_url;
        }

        const post = await prisma.post.create({
            data: {
                content,
                image: imageUrl,
                userId: req.user.id,
            },
        });

        res.json(post);
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error" });
    }
};

const deletePost = async (req, res) => {
    try {
        const { postId } = req.params;
        const post = await prisma.post.findUnique({ where: { id: postId } });

        if (!post) return res.status(404).json({ message: "Post not found" });
        if (post.userId !== req.user.id) return res.status(403).json({ message: "Unauthorized" });

        await prisma.post.delete({ where: { id: postId } });
        res.json({ message: "Post deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const updatePost = async (req, res) => {
    try {
        const { postId } = req.params;
        const post = await prisma.post.findUnique({ where: { id: postId } });

        if (!post) return res.status(404).json({ message: "Post not found" });
        if (post.userId !== req.user.id) return res.status(403).json({ message: "Unauthorized" });

        const updatedPost = await prisma.post.update({
            where: { id: postId },
            data: { content: req.body.content }
        });

        res.json({ message: "Post updated successfully", updatedPost });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

module.exports = { getPostById, createPost, deletePost, updatePost };
