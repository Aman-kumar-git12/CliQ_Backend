const { prisma } = require("../../../prisma/prismaClient");
const { buildPostInclude, formatPosts } = require("../../utils/posts/postPresenter");

const getPostFeed = async (req, res) => {
    const { id } = req.user;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const posts = await prisma.post.findMany({
        where: { userId: { not: id } },
        include: buildPostInclude(id),
        skip: skip,
        take: limit,
        orderBy: { createdAt: "desc" },
    });

    const totalCount = await prisma.post.count({
        where: { userId: { not: id } },
    });

    const formattedPosts = await formatPosts(posts);

    res.json({
        page,
        limit,
        hasMore: skip + posts.length < totalCount,
        posts: formattedPosts,
    });
};

const getRandomPostFeed = async (req, res) => {
    const { id: currentUserId } = req.user;
    const { excludeIds = [] } = req.body;
    const limit = 9;

    const randomDocs = await prisma.post.aggregateRaw({
        pipeline: [
            {
                $match: {
                    userId: { $ne: { $oid: currentUserId } },
                    _id: {
                        $nin: excludeIds.map((id) => ({ $oid: id })),
                    },
                },
            },
            { $sample: { size: limit } },
            { $project: { _id: 1 } },
        ],
    });

    if (!randomDocs || randomDocs.length === 0) {
        return res.json({ hasMore: false, posts: [] });
    }

    const randomIds = randomDocs.map((doc) => doc._id.$oid);

    const posts = await prisma.post.findMany({
        where: {
            id: { in: randomIds },
        },
        include: buildPostInclude(currentUserId),
    });

    // `in` returns DB order; keep the sampled order.
    const byId = new Map(posts.map((post) => [post.id, post]));
    const formattedPosts = await formatPosts(randomIds.map((postId) => byId.get(postId)));

    res.json({
        hasMore: formattedPosts.length === limit,
        posts: formattedPosts,
    });
};

const TRENDING_WINDOW_DAYS = 30;

const pageParams = (query) => {
    const page = Math.max(Number(query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 30);
    return { page, limit, skip: (page - 1) * limit };
};

// "Following" tab: newest posts from the people you are connected with
const getFollowingFeed = async (req, res) => {
    const { id } = req.user;
    const { page, limit, skip } = pageParams(req.query);

    const connections = await prisma.connectionsRequest.findMany({
        where: { status: "accepted", OR: [{ fromUserId: id }, { toUserId: id }] },
        select: { fromUserId: true, toUserId: true },
    });
    const connectionIds = connections.map((c) => (c.fromUserId === id ? c.toUserId : c.fromUserId));
    if (connectionIds.length === 0) return res.json({ page, limit, hasMore: false, posts: [] });

    const where = { userId: { in: connectionIds } };
    const [posts, totalCount] = await Promise.all([
        prisma.post.findMany({
            where,
            include: buildPostInclude(id),
            skip,
            take: limit,
            orderBy: { createdAt: "desc" },
        }),
        prisma.post.count({ where }),
    ]);

    res.json({ page, limit, hasMore: skip + posts.length < totalCount, posts: await formatPosts(posts) });
};

// "Trending" tab: the last 30 days of posts, most liked first
const getTrendingFeed = async (req, res) => {
    const { id } = req.user;
    const { page, limit, skip } = pageParams(req.query);
    const since = new Date(Date.now() - TRENDING_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    const where = { createdAt: { gte: since } };
    const [posts, totalCount] = await Promise.all([
        prisma.post.findMany({
            where,
            include: buildPostInclude(id),
            skip,
            take: limit,
            orderBy: [{ likes: { _count: "desc" } }, { createdAt: "desc" }],
        }),
        prisma.post.count({ where }),
    ]);

    res.json({ page, limit, hasMore: skip + posts.length < totalCount, posts: await formatPosts(posts) });
};

module.exports = {
    getPostFeed,
    getRandomPostFeed,
    getFollowingFeed,
    getTrendingFeed,
};
