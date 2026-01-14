const { prisma } = require("../../prisma/prismaClient");
const cloudinary = require("../upload/cloudinary");

const getAllPosts = async (req, res) => {
    try {
        const currentUserId = req.user.id;
        const posts = await prisma.post.findMany({
            include: {
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

        // Validate ObjectID format
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

const createLike = async (req, res) => {
    try {
        const { postId } = req.params;
        const userId = req.user.id;

        // Validate ObjectID format
        if (!/^[0-9a-fA-F]{24}$/.test(postId)) {
            return res.status(400).json({ message: "Invalid Post ID format" });
        }

        const existingLike = await prisma.like.findUnique({
            where: {
                userId_postId: {
                    userId,
                    postId
                }
            }
        });

        if (existingLike && existingLike.isLiked) {
            await prisma.like.update({
                where: { id: existingLike.id },
                data: { isLiked: false }
            });
            return res.json({ message: "Post unliked", isLiked: false });
        } else if (existingLike && !existingLike.isLiked) {
            await prisma.like.update({
                where: { id: existingLike.id },
                data: { isLiked: true }
            });
            return res.json({ message: "Post liked", isLiked: true });
        } else {
            await prisma.like.create({
                data: {
                    userId,
                    postId,
                    isLiked: true
                }
            });
            return res.json({ message: "Post liked", isLiked: true });
        }
    } catch (error) {
        console.error("Error in createLike:", error);
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
                user: {
                    select: {
                        firstname: true,
                        lastname: true,
                        imageUrl: true
                    }
                },
                reports: {
                    where: { userId: currentUserId }
                }
            },
            orderBy: { createdAt: 'desc' }
        });

        const formattedComments = comments.map(c => ({
            ...c,
            username: c.user ? (c.user.firstname + " " + c.user.lastname) : "Anonymous",
            avatar: c.user ? c.user.imageUrl : "https://github.com/shadcn.png",
            isReported: c.reports && c.reports.length > 0
        }));

        res.json(formattedComments);
    } catch (error) {
        console.error("Error in getCommentsByPostId:", error);
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
            include: {
                _count: {
                    select: {
                        likes: { where: { isLiked: true } },
                        comments: true
                    }
                },
                likes: {
                    where: { userId: id }
                },
                reports: {
                    where: { userId: id }
                }
            },
            skip: skip,
            take: limit,
            orderBy: { createdAt: "desc" }
        });

        const totalCount = await prisma.post.count({
            where: { userId: { not: id } }
        });

        const formattedPosts = posts.map(post => ({
            ...post,
            likes: post._count.likes,
            comments: post._count.comments,
            isLiked: post.likes.length > 0 && post.likes[0].isLiked === true,
            isReported: post.reports && post.reports.length > 0
        }));

        res.json({
            page,
            limit,
            hasMore: skip + posts.length < totalCount,
            posts: formattedPosts
        });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getRandomPostFeed = async (req, res) => {
    try {
        const { id: currentUserId } = req.user;
        const { excludeIds = [] } = req.body;
        const limit = 5;

        // 1. Get random post IDs excluding already seen ones and own posts
        const randomDocs = await prisma.post.aggregateRaw({
            pipeline: [
                {
                    $match: {
                        userId: { $ne: { "$oid": currentUserId } }, // Correctly match ObjectId
                        _id: {
                            $nin: excludeIds.map(id => ({ "$oid": id })) // Exclude seen IDs
                        }
                    }
                },
                { $sample: { size: limit } }, // Random sample of 5
                { $project: { _id: 1 } } // Only need IDs
            ]
        });

        // If no more posts found
        if (!randomDocs || randomDocs.length === 0) {
            return res.json({
                hasMore: false,
                posts: []
            });
        }

        // Convert aggregated IDs back to strings
        const randomIds = randomDocs.map(doc => doc._id.$oid);

        // 2. Fetch full details for these random IDs
        const posts = await prisma.post.findMany({
            where: {
                id: { in: randomIds }
            },
            include: {
                _count: {
                    select: {
                        likes: { where: { isLiked: true } },
                        comments: true
                    }
                },
                likes: { where: { userId: currentUserId } },
                reports: { where: { userId: currentUserId } },
                user: {
                    select: {
                        firstname: true,
                        lastname: true,
                        imageUrl: true
                    }
                }
            }
        });

        // 3. Format posts
        const formattedPosts = posts.map(post => ({
            ...post,
            likes: post._count.likes,
            comments: post._count.comments,
            isLiked: post.likes.length > 0 && post.likes[0].isLiked === true,
            isReported: post.reports && post.reports.length > 0,
            // Add user details directly to root if frontend expects it, or keep nested
            username: post.user ? `${post.user.firstname} ${post.user.lastname}` : "Unknown",
            avatar: post.user?.imageUrl || "https://github.com/shadcn.png"
        }));

        res.json({
            hasMore: formattedPosts.length === limit, // Heuristic: if we got less than requested, we might be out
            posts: formattedPosts
        });

    } catch (error) {
        console.error("Random Feed Error:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getLikesCount = async (req, res) => {
    try {
        const { postId } = req.params;
        const count = await prisma.like.count({
            where: {
                postId,
                isLiked: true
            }
        });
        res.json({ likesCount: count });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const deleteComment = async (req, res) => {
    try {
        const { commentId } = req.params;
        const userId = req.user.id; // From userAuth middleware

        // Check if comment exists and belongs to the user
        const comment = await prisma.comment.findUnique({
            where: { id: commentId }
        });

        if (!comment) {
            return res.status(404).json({ message: "Comment not found" });
        }

        if (comment.userId !== userId) {
            return res.status(403).json({ message: "You can only delete your own comments" });
        }

        await prisma.comment.delete({
            where: { id: commentId }
        });

        res.json({ message: "Comment deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const reportPost = async (req, res) => {
    try {
        const { postId } = req.params;
        const { reason } = req.body;
        const userId = req.user.id;

        if (!reason) {
            return res.status(400).json({ message: "Reason is required to report a post" });
        }

        // Check for existing report
        const existingReport = await prisma.report.findFirst({
            where: { userId, postId }
        });

        if (existingReport) {
            return res.status(400).json({ message: "You have already reported this post" });
        }

        const report = await prisma.report.create({
            data: {
                reason,
                postId,
                userId
            }
        });

        res.json({ message: "Post reported successfully", report });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const reportComment = async (req, res) => {
    try {
        const { commentId } = req.params;
        const { reason } = req.body;
        const userId = req.user.id;

        if (!reason) {
            return res.status(400).json({ message: "Reason is required to report a comment" });
        }

        // Check for existing report
        const existingReport = await prisma.report.findFirst({
            where: { userId, commentId }
        });

        if (existingReport) {
            return res.status(400).json({ message: "You have already reported this comment" });
        }

        const report = await prisma.report.create({
            data: {
                reason,
                commentId,
                userId
            }
        });

        res.json({ message: "Comment reported successfully", report });
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
    deleteComment,
    createPost,
    deletePost,
    updatePost,
    getPostFeed,
    createLike,
    getLikesCount,
    reportPost,
    reportComment,
    getRandomPostFeed
};
