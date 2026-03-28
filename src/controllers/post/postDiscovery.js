const { prisma } = require("../../../prisma/prismaClient");
const { formatPost } = require("./postUtils");

const getRandomPostFeed = async (req, res) => {
    try {
        const { id: currentUserId } = req.user;
        const { excludeIds = [] } = req.body;
        const limit = 9;

        const randomDocs = await prisma.post.aggregateRaw({
            pipeline: [
                {
                    $match: {
                        userId: { $ne: { "$oid": currentUserId } },
                        _id: { $nin: excludeIds.map(id => ({ "$oid": id })) }
                    }
                },
                { $sample: { size: limit } },
                { $project: { _id: 1 } }
            ]
        });

        if (!randomDocs || randomDocs.length === 0) {
            return res.json({ hasMore: false, posts: [] });
        }

        const randomIds = randomDocs.map(doc => doc._id.$oid);

        const posts = await prisma.post.findMany({
            where: { id: { in: randomIds } },
            include: {
                _count: { select: { likes: { where: { isLiked: true } }, comments: true } },
                likes: { where: { userId: currentUserId } },
                reports: { where: { userId: currentUserId } },
                user: { select: { firstname: true, lastname: true, imageUrl: true } }
            }
        });

        const formattedPosts = posts.map(post => formatPost(post, currentUserId));

        res.json({
            hasMore: formattedPosts.length === limit,
            posts: formattedPosts
        });
    } catch (error) {
        console.error("Random Feed Error:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

module.exports = { getRandomPostFeed };
