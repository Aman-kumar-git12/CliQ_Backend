const { prisma } = require("../../prisma/prismaClient");
const cloudinary = require("../upload/cloudinary");

const getAllPosts = async (req, res) => {
    try {
        const currentUserId = req.user.id;
        const posts = await prisma.post.findMany({
            include: {
                user: {
                    select: {
                        firstname: true,
                        lastname: true,
                        imageUrl: true
                    }
                },
                _count: {
                    select: {
                        likes: { where: { isLiked: true } },
                        comments: true
                    }
                },
                likes: {
                    where: { userId: currentUserId }
                },
                reports: {
                    where: { userId: currentUserId }
                }
            }
        });
        const formattedPosts = posts.map(post => ({
            ...post,
            username: post.user ? `${post.user.firstname} ${post.user.lastname}` : "Anonymous",
            avatar: post.user?.imageUrl || "https://github.com/shadcn.png",
            likes: post._count.likes,
            comments: post._count.comments,
            isLiked: post.likes.length > 0 && post.likes[0].isLiked === true,
            isReported: post.reports && post.reports.length > 0
        }));
        res.json(formattedPosts);
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getPostsByUserId = async (req, res) => {
    try {
        const { userId } = req.params;
        const currentUserId = req.user.id;
        const posts = await prisma.post.findMany({
            where: { userId },
            include: {
                user: {
                    select: {
                        firstname: true,
                        lastname: true,
                        imageUrl: true
                    }
                },
                _count: {
                    select: {
                        likes: { where: { isLiked: true } },
                        comments: true
                    }
                },
                likes: {
                    where: { userId: currentUserId }
                },
                reports: {
                    where: { userId: currentUserId }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
        const formattedPosts = posts.map(post => ({
            ...post,
            username: post.user ? `${post.user.firstname} ${post.user.lastname}` : "Anonymous",
            avatar: post.user?.imageUrl || "https://github.com/shadcn.png",
            likes: post._count.likes,
            comments: post._count.comments,
            isLiked: post.likes.length > 0 && post.likes[0].isLiked === true,
            isReported: post.reports && post.reports.length > 0
        }));
        res.json(formattedPosts);
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getPostById = async (req, res) => {
    try {
        const { postId } = req.params;
        const currentUserId = req.user.id;
        console.log("Fetching post ID:", postId, "for user:", currentUserId);

        if (!/^[0-9a-fA-F]{24}$/.test(postId)) {
            return res.status(400).json({ message: "Invalid Post ID format" });
        }

        const post = await prisma.post.findUnique({
            where: { id: postId },
            include: {
                user: {
                    select: {
                        firstname: true,
                        lastname: true,
                        imageUrl: true
                    }
                },
                _count: {
                    select: { comments: true }
                },
                likes: {
                    where: { userId: currentUserId }
                },
                reports: {
                    where: { userId: currentUserId }
                }
            }
        });

        if (!post) {
            console.log("Post not found:", postId);
            return res.status(404).json({ message: "Post not found" });
        }

        const likesCount = await prisma.like.count({
            where: { postId, isLiked: true }
        });

        const formattedPost = {
            ...post,
            username: post.user ? (post.user.firstname + " " + post.user.lastname) : "Anonymous",
            avatar: post.user ? post.user.imageUrl : "https://github.com/shadcn.png",
            likes: likesCount,
            comments: post._count.comments,
            isLiked: post.likes.length > 0 && post.likes[0].isLiked === true,
            isReported: post.reports && post.reports.length > 0
        };

        res.json(formattedPost);
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

module.exports = {
    getAllPosts,
    getPostsByUserId,
    getPostById,
    createPost,
    deletePost,
    updatePost
};
