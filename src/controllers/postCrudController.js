const { prisma } = require("../../prisma/prismaClient");
const cloudinary = require("../upload/cloudinary");
const { buildPostInclude, formatPost, formatPosts } = require("../utils/postPresenter");
const { isObjectId, resolveMentionIds, parseIdList, extractFirstUrl } = require("../utils/contentUtils");
const { getLinkPreview } = require("../utils/linkPreviewUtils");
const { createNotification, removeNotifications, notifyMentions } = require("../utils/notificationUtils");

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
    try {
        const posts = await prisma.post.findMany({
            include: buildPostInclude(req.user.id),
            orderBy: { createdAt: "desc" },
        });
        res.json(await formatPosts(posts));
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getPostsByUserId = async (req, res) => {
    try {
        const { userId } = req.params;
        if (!isObjectId(userId)) {
            return res.status(400).json({ message: "Invalid User ID format" });
        }
        const posts = await prisma.post.findMany({
            where: { userId },
            include: buildPostInclude(req.user.id),
            orderBy: { createdAt: "desc" },
        });
        res.json(await formatPosts(posts));
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getPostById = async (req, res) => {
    try {
        const { postId } = req.params;
        if (!isObjectId(postId)) {
            return res.status(400).json({ message: "Invalid Post ID format" });
        }

        const post = await prisma.post.findUnique({
            where: { id: postId },
            include: buildPostInclude(req.user.id),
        });
        if (!post) {
            return res.status(404).json({ message: "Post not found" });
        }

        res.json(await formatPost(post));
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const uploadToCloudinary = (fileBuffer, folder, resourceType = "auto") => new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
        { folder, resource_type: resourceType },
        (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(fileBuffer);
});

const createPost = async (req, res) => {
    try {
        const content = typeof req.body.content === "string" ? req.body.content.trim() : "";
        const postData = { content, userId: req.user.id };

        if (req.files?.image?.[0]) {
            postData.image = (await uploadToCloudinary(req.files.image[0].buffer, "posts", "image")).secure_url;
        }
        if (req.files?.video?.[0]) {
            postData.video = (await uploadToCloudinary(req.files.video[0].buffer, "posts", "video")).secure_url;
        }

        Object.assign(postData, await buildContentFields(content, parseIdList(req.body.mentionIds)));

        const created = await prisma.post.create({ data: postData });
        await notifyMentions({ mentionIds: created.mentionIds, actorId: req.user.id, postId: created.id });

        const post = await prisma.post.findUnique({ where: { id: created.id }, include: buildPostInclude(req.user.id) });
        res.json(await formatPost(post));
    } catch (error) {
        console.error("Post creation error:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const deletePost = async (req, res) => {
    try {
        const { postId } = req.params;
        if (!isObjectId(postId)) {
            return res.status(400).json({ message: "Invalid Post ID format" });
        }

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
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const updatePost = async (req, res) => {
    try {
        const { postId } = req.params;
        if (!isObjectId(postId)) {
            return res.status(400).json({ message: "Invalid Post ID format" });
        }

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
        await notifyMentions({
            mentionIds: fields.mentionIds.filter((id) => !previous.has(id)),
            actorId: req.user.id,
            postId,
        });

        res.json({ message: "Post updated successfully", updatedPost: await formatPost(updated) });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

/**
 * POST /user/post/repost/:postId  { content? }
 * Without content: toggles a plain repost. With content: creates a quote post.
 * Reposting a plain repost targets its original.
 */
const repostPost = async (req, res) => {
    try {
        const { postId } = req.params;
        const userId = req.user.id;
        const content = typeof req.body?.content === "string" ? req.body.content.trim() : "";

        if (!isObjectId(postId)) {
            return res.status(400).json({ message: "Invalid Post ID format" });
        }
        if (content.length > MAX_CONTENT_LENGTH) {
            return res.status(400).json({ message: `Content length should be less than or equal to ${MAX_CONTENT_LENGTH}` });
        }

        const target = await prisma.post.findUnique({ where: { id: postId } });
        if (!target) {
            return res.status(404).json({ message: "Post not found" });
        }

        const isPlainRepost = target.repostOfId && !target.content.trim();
        const original = isPlainRepost
            ? await prisma.post.findUnique({ where: { id: target.repostOfId } })
            : target;
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
                return res.json({ message: "Repost removed", isReposted: false, originalId: original.id, repostsCount });
            }
        }

        const fields = content ? await buildContentFields(content, parseIdList(req.body?.mentionIds)) : {};
        const created = await prisma.post.create({
            data: { content, userId, repostOfId: original.id, ...fields },
        });

        await createNotification({ recipientId: original.userId, actorId: userId, type: "repost", postId: original.id });
        if (fields.mentionIds?.length) {
            await notifyMentions({ mentionIds: fields.mentionIds, actorId: userId, postId: created.id, skipIds: [original.userId] });
        }

        const [post, repostsCount] = await Promise.all([
            prisma.post.findUnique({ where: { id: created.id }, include: buildPostInclude(userId) }),
            prisma.post.count({ where: { repostOfId: original.id } }),
        ]);
        res.json({
            message: content ? "Quote posted" : "Reposted",
            isReposted: content ? undefined : true,
            originalId: original.id,
            repostsCount,
            post: await formatPost(post),
        });
    } catch (error) {
        console.error("Repost error:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

// POST /user/post/save/:postId — toggles a bookmark.
const toggleSavePost = async (req, res) => {
    try {
        const { postId } = req.params;
        const userId = req.user.id;
        if (!isObjectId(postId)) {
            return res.status(400).json({ message: "Invalid Post ID format" });
        }

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
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

// GET /user/saved-posts?cursor=<savedPostId>
const getSavedPosts = async (req, res) => {
    try {
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
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

// GET /link-preview?url= — lets the composer show a preview while typing.
const previewLink = async (req, res) => {
    try {
        const preview = await getLinkPreview(req.query.url);
        res.json({ preview });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
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
