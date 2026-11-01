const { prisma } = require("../../../prisma/prismaClient");
const { publicUserSelect, listUserSelect, toPublicUser } = require("../../utils/auth/authUtils");
const {
    parseQuery,
    searchPeople,
    searchPosts,
    searchHashtags,
    suggestMentions,
    trendingHashtags,
} = require("../../utils/search/searchUtils");

const getSuggestedUsers = async (req, res) => {
    const loggedInUserId = req.user.id;

    const connections = await prisma.connectionsRequest.findMany({
        where: {
            OR: [{ toUserId: loggedInUserId }, { fromUserId: loggedInUserId }],
        },
        select: {
            fromUserId: true,
            toUserId: true,
        },
    });

    const excludedUserIds = new Set();
    connections.forEach((conn) => {
        excludedUserIds.add(conn.fromUserId);
        excludedUserIds.add(conn.toUserId);
    });
    excludedUserIds.add(loggedInUserId);

    const excludedArray = Array.from(excludedUserIds);

    const count = await prisma.users.count({
        where: { id: { notIn: excludedArray } },
    });

    const skip = count > 5 ? Math.floor(Math.random() * (count - 5 + 1)) : 0;

    const users = await prisma.users.findMany({
        where: { id: { notIn: excludedArray } },
        select: listUserSelect,
        skip: skip,
        take: 5,
    });

    res.json(users);
};

const SEARCH_TYPES = ["all", "people", "posts", "hashtags"];
const SEMANTIC_MODES = ["auto", "on", "off"];

// Legacy people-only endpoint used by Find People. Returns a plain array.
const searchUserByName = async (req, res) => {
    const parsed = parseQuery(req.params.name);
    const { people } = await searchPeople(parsed, req.user.id, { limit: 30 });
    res.json(people);
};

// GET /user/mention-suggestions?q=kun
const getMentionSuggestions = async (req, res) => {
    res.json(await suggestMentions(req.query.q, req.user.id));
};

// GET /search?q=react ml&type=all|people|posts|hashtags&limit=10&semantic=auto|on|off
const globalSearch = async (req, res) => {
    const type = SEARCH_TYPES.includes(req.query.type) ? req.query.type : "all";
    const semantic = SEMANTIC_MODES.includes(req.query.semantic) ? req.query.semantic : "auto";
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || (type === "all" ? 8 : 20), 1), 50);
    const parsed = parseQuery(req.query.q);

    if (parsed.tokens.length === 0) {
        return res.status(400).json({ message: "Search query is required" });
    }

    const wants = (section) => type === "all" || type === section;
    const [peopleResult, posts, hashtags] = await Promise.all([
        wants("people") ? searchPeople(parsed, req.user.id, { limit, semantic }) : null,
        wants("posts") ? searchPosts(parsed, { limit }) : null,
        wants("hashtags") ? searchHashtags(parsed, { limit: Math.min(limit, 10) }) : null,
    ]);

    res.json({
        query: parsed.query,
        type,
        people: peopleResult?.people ?? [],
        posts: posts ?? [],
        hashtags: hashtags ?? [],
        semantic: {
            used: Boolean(peopleResult?.semanticUsed),
            available: peopleResult ? peopleResult.semanticAvailable : true,
        },
    });
};

const getUserById = async (req, res) => {
    const { id } = req.params;

    // Validate ObjectId format to prevent Prisma 500 errors on invalid IDs (like "suggested" or "undefined")
    if (!id || id.length !== 24 || !/^[0-9a-fA-F]+$/.test(id)) {
        return res.status(404).json({ message: "Invalid User ID format" });
    }

    const user = await prisma.users.findUnique({
        where: { id },
        select: publicUserSelect,
    });

    if (!user) {
        return res.status(404).json({ message: "User not found" });
    }

    // Connections Count
    const connectionCount = await prisma.connectionsRequest.count({
        where: {
            status: "accepted",
            OR: [{ fromUserId: id }, { toUserId: id }],
        },
    });

    // Posts Count
    const postsCount = await prisma.post.count({
        where: { userId: id },
    });

    // Groups Count
    const groupsCount = await prisma.conversation.count({
        where: {
            isGroup: true,
            participantIds: { has: id },
        },
    });

    const userWithStats = {
        ...toPublicUser(user),
        postsCount,
        connectionsCount: connectionCount,
        groupsCount,
    };

    res.json({ user: userWithStats });
};

const getHoverCardData = async (req, res) => {
    const { id: targetUserId } = req.params;
    const currentUserId = req.user.id;

    // Fetch user basic info and counts
    const user = await prisma.users.findUnique({
        where: { id: targetUserId },
        select: {
            id: true,
            firstname: true,
            lastname: true,
            imageUrl: true,
            _count: {
                select: {
                    posts: true,
                },
            },
        },
    });

    if (!user) {
        return res.status(404).json({ message: "User not found" });
    }

    // Fetch accepted connections count
    const connectionsCount = await prisma.connectionsRequest.count({
        where: {
            status: "accepted",
            OR: [{ fromUserId: targetUserId }, { toUserId: targetUserId }],
        },
    });

    // Fetch groups count (Conversations where isGroup: true and user is participant)
    const groupsCount = await prisma.conversation.count({
        where: {
            isGroup: true,
            participantIds: { has: targetUserId },
        },
    });

    // Fetch 3 most recent posts with images
    const recentPosts = await prisma.post.findMany({
        where: {
            userId: targetUserId,
            image: { not: null },
        },
        take: 3,
        orderBy: { createdAt: "desc" },
        select: {
            id: true,
            image: true,
        },
    });

    // If not enough posts with images, fetch any recent posts
    if (recentPosts.length < 3) {
        const morePosts = await prisma.post.findMany({
            where: {
                userId: targetUserId,
                id: { notIn: recentPosts.map((p) => p.id) },
            },
            take: 3 - recentPosts.length,
            orderBy: { createdAt: "desc" },
            select: {
                id: true,
                image: true,
            },
        });
        recentPosts.push(...morePosts);
    }

    // Check connection status with current user
    const connection = await prisma.connectionsRequest.findFirst({
        where: {
            OR: [
                { fromUserId: currentUserId, toUserId: targetUserId },
                { fromUserId: targetUserId, toUserId: currentUserId },
            ],
        },
    });

    const hoverData = {
        id: user.id,
        firstname: user.firstname,
        lastname: user.lastname,
        username: `${user.firstname.toLowerCase()}_${user.lastname.toLowerCase()}`, // Default fallback
        imageUrl: user.imageUrl,
        postsCount: user._count.posts,
        connectionsCount,
        groupsCount,
        recentPosts,
        connectionStatus: connection ? connection.status : "none",
        isMe: currentUserId === targetUserId,
    };

    res.json(hoverData);
};

// GET /search/trending-hashtags
const getTrendingHashtags = async (req, res) => {
    res.json({ hashtags: await trendingHashtags(5) });
};

module.exports = {
    getTrendingHashtags,
    getSuggestedUsers,
    searchUserByName,
    globalSearch,
    getMentionSuggestions,
    getUserById,
    getHoverCardData,
};
