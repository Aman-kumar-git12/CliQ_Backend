const { prisma } = require("../../prisma/prismaClient");
const { extractHashtags, toHandle } = require("./contentUtils");

const DEFAULT_AVATAR = "https://github.com/shadcn.png";

const authorSelect = { id: true, firstname: true, lastname: true, imageUrl: true };

/**
 * One include for every post read, so feed, profile, single-post and saved
 * views all return the same shape. `repostOf` is only expanded one level.
 */
const buildPostInclude = (viewerId, { withRepostOf = true } = {}) => ({
    user: { select: authorSelect },
    _count: {
        select: {
            likes: { where: { isLiked: true } },
            comments: true,
            reposts: true,
        },
    },
    likes: { where: { userId: viewerId }, select: { isLiked: true } },
    reports: { where: { userId: viewerId }, select: { id: true } },
    saves: { where: { userId: viewerId }, select: { id: true } },
    // Plain reposts by the viewer (empty content); quotes don't count as "reposted".
    reposts: { where: { userId: viewerId, content: "" }, select: { id: true } },
    ...(withRepostOf ? { repostOf: { include: buildPostInclude(viewerId, { withRepostOf: false }) } } : {}),
});

const toMention = (user) => ({
    id: user.id,
    firstname: user.firstname,
    lastname: user.lastname,
    handle: toHandle(user),
});

const getMentionMap = async (posts) => {
    const ids = new Set();
    for (const post of posts) {
        (post.mentionIds || []).forEach((id) => ids.add(id));
        (post.repostOf?.mentionIds || []).forEach((id) => ids.add(id));
    }
    if (ids.size === 0) return new Map();

    const users = await prisma.users.findMany({
        where: { id: { in: [...ids] } },
        select: { id: true, firstname: true, lastname: true },
    });
    return new Map(users.map((u) => [u.id, toMention(u)]));
};

const formatOne = (post, mentionMap) => {
    if (!post) return null;
    const {
        _count, likes, reports, saves, reposts, repostOf, mentionIds = [], ...rest
    } = post;
    const content = post.content || "";
    const isRepost = Boolean(post.repostOfId);

    return {
        ...rest,
        content,
        username: post.user ? `${post.user.firstname} ${post.user.lastname}` : "Anonymous",
        handle: post.user ? toHandle(post.user) : "user",
        avatar: post.user?.imageUrl || DEFAULT_AVATAR,
        likes: _count?.likes ?? 0,
        comments: _count?.comments ?? 0,
        repostsCount: _count?.reposts ?? 0,
        isLiked: Boolean(likes?.[0]?.isLiked),
        isReported: (reports?.length ?? 0) > 0,
        isSaved: (saves?.length ?? 0) > 0,
        isReposted: (reposts?.length ?? 0) > 0,
        hashtags: [...new Set(extractHashtags(content))],
        mentions: mentionIds.map((id) => mentionMap.get(id)).filter(Boolean),
        isRepost,
        // Plain repost = no text of its own; the card renders the original.
        isQuote: isRepost && content.trim() !== "",
        // null with isRepost=true means the original was deleted.
        repostOf: repostOf ? formatOne(repostOf, mentionMap) : null,
    };
};

const formatPosts = async (posts) => {
    const list = posts.filter(Boolean);
    const mentionMap = await getMentionMap(list);
    return list.map((post) => formatOne(post, mentionMap));
};

const formatPost = async (post) => (post ? (await formatPosts([post]))[0] : null);

module.exports = {
    DEFAULT_AVATAR,
    authorSelect,
    buildPostInclude,
    formatPosts,
    formatPost,
    toMention,
};
