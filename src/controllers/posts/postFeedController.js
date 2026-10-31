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

module.exports = {
    getPostFeed,
    getRandomPostFeed,
};
