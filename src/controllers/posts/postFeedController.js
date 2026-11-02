const { prisma } = require("../../../prisma/prismaClient");
const { buildPostInclude, formatPosts } = require("../../utils/posts/postPresenter");

const FEED_LIMIT_DEFAULT = 10;
const FEED_LIMIT_MAX = 30;

const feedLimit = (query) => Math.min(Math.max(Number(query.limit) || FEED_LIMIT_DEFAULT, 1), FEED_LIMIT_MAX);

// Newest-first pages. With ?cursor=<id of the last post shown> the next page starts right after it,
// which stays fast however deep you scroll; ?page=N (offset) still works for older clients.
// The response carries nextCursor (null on the last page) and hasMore.
const newestFirstPage = async ({ where, query, userId }) => {
    const limit = feedLimit(query);
    const page = Math.max(Number(query.page) || 1, 1);
    const position = query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : { skip: (page - 1) * limit };

    // One extra row tells whether another page exists, without counting the whole collection
    const rows = await prisma.post.findMany({
        where,
        include: buildPostInclude(userId),
        ...position,
        take: limit + 1,
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    const hasMore = rows.length > limit;
    const posts = rows.slice(0, limit);

    return {
        ...(query.cursor ? {} : { page }),
        limit,
        hasMore,
        nextCursor: hasMore ? posts[posts.length - 1].id : null,
        posts: await formatPosts(posts),
    };
};

const getPostFeed = async (req, res) => {
    const { id } = req.user;
    res.json(await newestFirstPage({ where: { userId: { not: id } }, query: req.query, userId: id }));
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
    const limit = feedLimit(query);
    return { page, limit, skip: (page - 1) * limit };
};

// "Following" tab: newest posts from the people you are connected with
const getFollowingFeed = async (req, res) => {
    const { id } = req.user;

    const connections = await prisma.connectionsRequest.findMany({
        where: { status: "accepted", OR: [{ fromUserId: id }, { toUserId: id }] },
        select: { fromUserId: true, toUserId: true },
    });
    const connectionIds = connections.map((c) => (c.fromUserId === id ? c.toUserId : c.fromUserId));
    if (connectionIds.length === 0) {
        return res.json({ limit: feedLimit(req.query), hasMore: false, nextCursor: null, posts: [] });
    }

    res.json(await newestFirstPage({ where: { userId: { in: connectionIds } }, query: req.query, userId: id }));
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
