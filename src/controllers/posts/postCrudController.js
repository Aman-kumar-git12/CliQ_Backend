const { prisma } = require("../../../prisma/prismaClient");
const { uploadBuffer } = require("../../upload/cloudinary");
const { buildPostInclude, formatPost, formatPosts } = require("../../utils/posts/postPresenter");
const { isObjectId, resolveMentionIds, parseIdList, extractFirstUrl } = require("../../utils/posts/contentUtils");
const { getLinkPreview } = require("../../utils/posts/linkPreviewUtils");
const {
    createNotification,
    removeNotifications,
    notifyMentions,
} = require("../../utils/notifications/notificationUtils");

const MAX_CONTENT_LENGTH = 500;
const SAVED_PAGE_SIZE = 20;

// Mentions and the link preview are derived from the text on every create/edit.
const buildContentFields = async (content, hintedMentionIds) => {
    const url = extractFirstUrl(content);
    const [mentionIds, linkPreview] = await Promise.all([
        resolveMentionIds(content, hintedMentionIds),
        url ? getLinkPreview(url) : null,
    ]);
    return { mentionIds, linkPreview: linkPreview || null };
};

const getAllPosts = async (req, res) => {
    const posts = await prisma.post.findMany({
        include: buildPostInclude(req.user.id),
        orderBy: { createdAt: "desc" },
    });
    res.json(await formatPosts(posts));
};

const getPostsByUserId = async (req, res) => {
    const { userId } = req.params;
    const posts = await prisma.post.findMany({
        where: { userId },
        include: buildPostInclude(req.user.id),
        orderBy: { createdAt: "desc" },
    });
    res.json(await formatPosts(posts));
};

const getPostById = async (req, res) => {
    const { postId } = req.params;
    const post = await prisma.post.findUnique({
        where: { id: postId },
        include: buildPostInclude(req.user.id),
    });
    if (!post) {
        return res.status(404).json({ message: "Post not found" });
    }

    res.json(await formatPost(post));
};

const createPost = async (req, res) => {
    const content = typeof req.body.content === "string" ? req.body.content.trim() : "";
    const image = req.files?.image?.[0];
    const video = req.files?.video?.[0];

    // The uploads and the mention/link-preview lookups don't depend on each other
    const [imageUpload, videoUpload, contentFields] = await Promise.all([
        image ? uploadBuffer(image, { folder: "posts", resource_type: "image" }) : null,
        video ? uploadBuffer(video, { folder: "posts", resource_type: "video" }) : null,
        buildContentFields(content, parseIdList(req.body.mentionIds)),
    ]);
    const postData = {
        content,
        userId: req.user.id,
        ...(imageUpload ? { image: imageUpload.secure_url } : {}),
        ...(videoUpload ? { video: videoUpload.secure_url } : {}),
        ...contentFields,
    };

    const created = await prisma.post.create({ data: postData });
    const [post] = await Promise.all([
        prisma.post.findUnique({
            where: { id: created.id },
            include: buildPostInclude(req.user.id),
        }),
        notifyMentions({ mentionIds: created.mentionIds, actorId: req.user.id, postId: created.id }),
    ]);
    res.json(await formatPost(post));
};

const deletePost = async (req, res) => {
    const { postId } = req.params;
    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) {
        return res.status(404).json({ message: "Post not found" });
    }
    if (post.userId !== req.user.id) {
        return res.status(403).json({ message: "You are not authorized to delete this post" });
    }

    // The Reposts self-relation is NoAction, so clean up before deleting:
    // plain reposts go away with the original; quotes keep their own text.
    await prisma.post.deleteMany({ where: { repostOfId: postId, content: "" } });
    await prisma.post.updateMany({ where: { repostOfId: postId }, data: { repostOfId: null } });
    const deletedPost = await prisma.post.delete({ where: { id: postId } });

    res.json({ message: "Post deleted successfully", deletedPost });
};

const updatePost = async (req, res) => {
    const { postId } = req.params;
    const post = await prisma.post.findUnique({ where: { id: postId } });
    if (!post) {
        return res.status(404).json({ message: "Post not found" });
    }
    if (post.userId !== req.user.id) {
        return res.status(403).json({ message: "You are not authorized to update this post" });
    }

    const content = req.body.content.trim();
    const fields = await buildContentFields(content, parseIdList(req.body.mentionIds));
    const updated = await prisma.post.update({
        where: { id: postId },
        data: { content, ...fields },
        include: buildPostInclude(req.user.id),
    });

    // Only people newly mentioned by this edit get notified.
    const previous = new Set(post.mentionIds || []);
    const [updatedPost] = await Promise.all([
        formatPost(updated),
        notifyMentions({
            mentionIds: fields.mentionIds.filter((id) => !previous.has(id)),
            actorId: req.user.id,
            postId,
        }),
    ]);

    res.json({ message: "Post updated successfully", updatedPost });
};

/**
 * POST /user/post/repost/:postId  { content? }
 * Without content: toggles a plain repost. With content: creates a quote post.
 * Reposting a plain repost targets its original.
 */
const repostPost = async (req, res) => {
    const { postId } = req.params;
    const userId = req.user.id;
    const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";

    if (content.length > MAX_CONTENT_LENGTH) {
        return res
            .status(400)
            .json({ message: `Content length should be less than or equal to ${MAX_CONTENT_LENGTH}` });
    }

    const target = await prisma.post.findUnique({ where: { id: postId } });
    if (!target) {
        return res.status(404).json({ message: "Post not found" });
    }

    const isPlainRepost = target.repostOfId && !target.content.trim();
    const original = isPlainRepost ? await prisma.post.findUnique({ where: { id: target.repostOfId } }) : target;
    if (!original) {
        return res.status(404).json({ message: "Original post no longer exists" });
    }

    if (!content) {
        const existing = await prisma.post.findFirst({
            where: { userId, repostOfId: original.id, content: "" },
            select: { id: true },
        });

        if (existing) {
            await prisma.post.delete({ where: { id: existing.id } });
            await removeNotifications({ type: "repost", actorId: userId, postId: original.id });
            const repostsCount = await prisma.post.count({ where: { repostOfId: original.id } });
            return res.json({
                message: "Repost removed",
                isReposted: false,
                originalId: original.id,
                repostsCount,
            });
        }
    }

    const fields = content ? await buildContentFields(content, parseIdList(req.body?.mentionIds)) : {};
    const created = await prisma.post.create({
        data: { content, userId, repostOfId: original.id, ...fields },
    });

    const [post, repostsCount] = await Promise.all([
        prisma.post.findUnique({ where: { id: created.id }, include: buildPostInclude(userId) }),
        prisma.post.count({ where: { repostOfId: original.id } }),
        createNotification({
            recipientId: original.userId,
            actorId: userId,
            type: "repost",
            postId: original.id,
        }),
        fields.mentionIds?.length
            ? notifyMentions({
                  mentionIds: fields.mentionIds,
                  actorId: userId,
                  postId: created.id,
                  skipIds: [original.userId],
              })
            : null,
    ]);
    res.json({
        message: content ? "Quote posted" : "Reposted",
        isReposted: content ? undefined : true,
        originalId: original.id,
        repostsCount,
        post: await formatPost(post),
    });
};

// POST /user/post/save/:postId — toggles a bookmark.
const toggleSavePost = async (req, res) => {
    const { postId } = req.params;
    const userId = req.user.id;
    const post = await prisma.post.findUnique({ where: { id: postId }, select: { id: true } });
    if (!post) {
        return res.status(404).json({ message: "Post not found" });
    }

    const existing = await prisma.savedPost.findUnique({ where: { userId_postId: { userId, postId } } });
    if (existing) {
        await prisma.savedPost.delete({ where: { id: existing.id } });
        return res.json({ message: "Post removed from saved", isSaved: false });
    }

    try {
        await prisma.savedPost.create({ data: { userId, postId } });
    } catch (err) {
        // A double-click can race the unique index; it's saved either way.
        if (err?.code !== "P2002") throw err;
    }
    res.json({ message: "Post saved", isSaved: true });
};

// GET /user/saved-posts?cursor=<savedPostId>
const getSavedPosts = async (req, res) => {
    const userId = req.user.id;
    const { cursor } = req.query;
    if (cursor && !isObjectId(cursor)) {
        return res.status(400).json({ message: "Invalid cursor" });
    }

    const saved = await prisma.savedPost.findMany({
        where: { userId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: SAVED_PAGE_SIZE + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        include: { post: { include: buildPostInclude(userId) } },
    });

    const hasMore = saved.length > SAVED_PAGE_SIZE;
    const page = hasMore ? saved.slice(0, SAVED_PAGE_SIZE) : saved;
    const withPost = page.filter((s) => s.post);
    const posts = await formatPosts(withPost.map((s) => s.post));

    res.json({
        posts: posts.map((post, i) => ({ ...post, savedAt: withPost[i].createdAt })),
        nextCursor: hasMore ? page[page.length - 1].id : null,
    });
};

// GET /link-preview?url= — lets the composer show a preview while typing.
const previewLink = async (req, res) => {
    const preview = await getLinkPreview(req.query.url);
    res.json({ preview });
};

module.exports = {
    getAllPosts,
    getPostsByUserId,
    getPostById,
    createPost,
    deletePost,
    updatePost,
    repostPost,
    toggleSavePost,
    getSavedPosts,
    previewLink,
};
