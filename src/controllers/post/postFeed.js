const { prisma } = require("../../../prisma/prismaClient");
const { formatPost } = require("./postUtils");

const POST_INCLUDE = (currentUserId) => ({
    user: { select: { firstname: true, lastname: true, imageUrl: true } },
    _count: { select: { likes: { where: { isLiked: true } }, comments: true } },
    likes: { where: { userId: currentUserId } },
    reports: { where: { userId: currentUserId } }
});

const getAllPosts = async (req, res) => {
    try {
        const currentUserId = req.user.id;
        const posts = await prisma.post.findMany({ include: POST_INCLUDE(currentUserId) });
        res.json(posts.map(post => formatPost(post, currentUserId)));
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
            include: POST_INCLUDE(currentUserId),
            orderBy: { createdAt: 'desc' }
        });
        res.json(posts.map(p => formatPost(p, currentUserId)));
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
            include: POST_INCLUDE(id),
            skip: skip,
            take: limit,
            orderBy: { createdAt: "desc" }
        });

        const totalCount = await prisma.post.count({ where: { userId: { not: id } } });

        res.json({
            page,
            limit,
            hasMore: skip + posts.length < totalCount,
            posts: posts.map(p => formatPost(p, id))
        });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

module.exports = { getAllPosts, getPostsByUserId, getPostFeed };
