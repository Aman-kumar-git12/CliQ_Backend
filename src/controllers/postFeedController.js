const { prisma } = require("../../prisma/prismaClient");

const getPostFeed = async (req, res) => {
    try {
        const { id } = req.user;
        const page = Number(req.query.page) || 1;
        const limit = Number(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const posts = await prisma.post.findMany({
            where: { userId: { not: id } },
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
            username: post.user ? `${post.user.firstname} ${post.user.lastname}` : "Anonymous",
            avatar: post.user?.imageUrl || "https://github.com/shadcn.png",
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
        const limit = 9;

        const randomDocs = await prisma.post.aggregateRaw({
            pipeline: [
                {
                    $match: {
                        userId: { $ne: { "$oid": currentUserId } },
                        _id: {
                            $nin: excludeIds.map(id => ({ "$oid": id }))
                        }
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

        const formattedPosts = posts.map(post => ({
            ...post,
            likes: post._count.likes,
            comments: post._count.comments,
            isLiked: post.likes.length > 0 && post.likes[0].isLiked === true,
            isReported: post.reports && post.reports.length > 0,
            username: post.user ? `${post.user.firstname} ${post.user.lastname}` : "Unknown",
            avatar: post.user?.imageUrl || "https://github.com/shadcn.png"
        }));

        res.json({
            hasMore: formattedPosts.length === limit,
            posts: formattedPosts
        });
    } catch (error) {
        console.error("Random Feed Error:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

module.exports = {
    getPostFeed,
    getRandomPostFeed
};
