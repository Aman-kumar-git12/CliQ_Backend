const { prisma } = require("../../prisma/prismaClient");
const cloudinary = require("../upload/cloudinary");

const getAllPosts = async (req, res) => {
    try {
        const posts = await prisma.post.findMany();
        res.json(posts);
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getPostsByUserId = async (req, res) => {
    try {
        const { userId } = req.params;
        const posts = await prisma.post.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' }
        });
        res.json(posts);
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getPostById = async (req, res) => {
    try {
        const { postId } = req.params;
        const post = await prisma.post.findUnique({
            where: { id: postId }
        });
        res.json(post);
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const addComment = async (req, res) => {
    try {
        const { postId } = req.params;
        const { comment } = req.body;
        const { id } = req.user;
        const newComment = await prisma.comment.create({
            data: {
                userId: id,
                postId,
                comment
            }
        });
        res.json(newComment);
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getCommentsByPostId = async (req, res) => {
    try {
        const { postId } = req.params;
        const comments = await prisma.comment.findMany({
            where: { postId }
        });
        res.json(comments);
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
        const post = await prisma.post.findUnique({
            where: { id: postId }
        });

        if (!post) {
            return res.status(404).json({ message: "Post not found" });
        }

        if (post.userId !== req.user.id) {
            return res.status(403).json({ message: "You are not authorized to delete this post" });
        }

        const deletedPost = await prisma.post.delete({
            where: { id: postId }
        });

        res.json({ message: "Post deleted successfully", deletedPost });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const updatePost = async (req, res) => {
    try {
        const { postId } = req.params;
        const post = await prisma.post.findUnique({
            where: { id: postId }
        });

        if (!post) {
            return res.status(404).json({ message: "Post not found" });
        }

        if (post.userId !== req.user.id) {
            return res.status(403).json({ message: "You are not authorized to update this post" });
        }

        const updatedPost = await prisma.post.update({
            where: { id: postId },
            data: { content: req.body.content }
        });

        res.json({ message: "Post updated successfully", updatedPost });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getPostFeed = async (req, res) => {
    try {
        const { id } = req.user;
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const posts = await prisma.post.findMany({
            where: { userId: { not: id } },
            skip: skip,
            take: limit,
            orderBy: { createdAt: "desc" }
        });

        const totalCount = await prisma.post.count({
            where: { userId: { not: id } }
        });

        res.json({
            page,
            limit,
            hasMore: skip + posts.length < totalCount,
            posts: posts
        });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

module.exports = {
    getAllPosts,
    getPostsByUserId,
    getPostById,
    addComment,
    getCommentsByPostId,
    createPost,
    deletePost,
    updatePost,
    getPostFeed
};
