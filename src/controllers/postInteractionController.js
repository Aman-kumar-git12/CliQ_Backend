const { prisma } = require("../../prisma/prismaClient");
const { createNotification, removeNotifications, notifyMentions } = require("../utils/notificationUtils");
const { resolveMentionIds, parseIdList, toHandle } = require("../utils/contentUtils");
const { authorSelect, DEFAULT_AVATAR, toMention } = require("../utils/postPresenter");

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

const MAX_COMMENT_LENGTH = 1000;

const commentInclude = (viewerId) => ({
    user: { select: authorSelect },
    reports: { where: { userId: viewerId }, select: { id: true } },
});

const formatComment = (c, mentionMap) => {
    const { reports, mentionIds = [], ...rest } = c;
    return {
        ...rest,
        username: c.user ? `${c.user.firstname} ${c.user.lastname}` : "Anonymous",
        handle: c.user ? toHandle(c.user) : "user",
        avatar: c.user?.imageUrl || DEFAULT_AVATAR,
        isReported: (reports?.length ?? 0) > 0,
        mentions: mentionIds.map((id) => mentionMap.get(id)).filter(Boolean),
    };
};

const getCommentMentionMap = async (comments) => {
    const ids = [...new Set(comments.flatMap((c) => c.mentionIds || []))];
    if (ids.length === 0) return new Map();
    const users = await prisma.users.findMany({
        where: { id: { in: ids } },
        select: { id: true, firstname: true, lastname: true },
    });
    return new Map(users.map((u) => [u.id, toMention(u)]));
};

/**
 * POST /user/post/comments/:postId  { comment, parentId?, mentionIds? }
 * Replies are one level deep: replying to a reply attaches to its top-level comment.
 */
const addComment = async (req, res) => {
    try {
        const { postId } = req.params;
        const comment = typeof req.body?.comment === "string" ? req.body.comment.trim() : "";
        const { parentId } = req.body || {};
        const { id } = req.user;

        if (!OBJECT_ID_REGEX.test(postId)) {
            return res.status(400).json({ message: "Invalid Post ID format" });
        }
        if (!comment) {
            return res.status(400).json({ message: "Comment cannot be empty" });
        }
        if (comment.length > MAX_COMMENT_LENGTH) {
            return res.status(400).json({ message: `Comment must be ${MAX_COMMENT_LENGTH} characters or fewer` });
        }
        if (parentId && !OBJECT_ID_REGEX.test(parentId)) {
            return res.status(400).json({ message: "Invalid parent comment ID" });
        }

        const post = await prisma.post.findUnique({
            where: { id: postId },
            select: { id: true, userId: true }
        });
        if (!post) {
            return res.status(404).json({ message: "Post not found" });
        }

        let parent = null;
        if (parentId) {
            parent = await prisma.comment.findUnique({
                where: { id: parentId },
                select: { id: true, postId: true, parentId: true, userId: true }
            });
            if (!parent || parent.postId !== postId) {
                return res.status(404).json({ message: "Parent comment not found" });
            }
        }

        const mentionIds = await resolveMentionIds(comment, parseIdList(req.body?.mentionIds));
        const created = await prisma.comment.create({
            data: {
                userId: id,
                postId,
                comment,
                mentionIds,
                parentId: parent ? (parent.parentId || parent.id) : null,
            },
            include: commentInclude(id),
        });

        // The person being replied to gets "reply"; the post owner gets "comment"
        // unless they are that person. Mentions skip anyone already notified.
        const notified = [];
        if (parent) {
            await createNotification({ recipientId: parent.userId, actorId: id, type: "reply", postId, commentId: created.id });
            notified.push(parent.userId);
        }
        if (!notified.includes(post.userId)) {
            await createNotification({ recipientId: post.userId, actorId: id, type: "comment", postId, commentId: created.id });
            notified.push(post.userId);
        }
        await notifyMentions({ mentionIds, actorId: id, postId, commentId: created.id, skipIds: notified });

        const mentionMap = await getCommentMentionMap([created]);
        res.json({ ...formatComment(created, mentionMap), replies: [], repliesCount: 0 });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

// Returns top-level comments (newest first), each with its replies (oldest first).
const getCommentsByPostId = async (req, res) => {
    try {
        const { postId } = req.params;
        const currentUserId = req.user.id;

        if (!OBJECT_ID_REGEX.test(postId)) {
            return res.status(400).json({ message: "Invalid Post ID format" });
        }

        const comments = await prisma.comment.findMany({
            where: { postId },
            include: commentInclude(currentUserId),
            orderBy: { createdAt: "asc" }
        });

        const mentionMap = await getCommentMentionMap(comments);
        const formatted = comments.map((c) => formatComment(c, mentionMap));
        const topLevel = formatted.filter((c) => !c.parentId);
        const topIds = new Set(topLevel.map((c) => c.id));
        const repliesByParent = new Map();
        for (const reply of formatted) {
            // A reply whose parent is gone is promoted to top level.
            if (!reply.parentId) continue;
            if (!topIds.has(reply.parentId)) {
                topLevel.push(reply);
                continue;
            }
            const list = repliesByParent.get(reply.parentId) || [];
            list.push(reply);
            repliesByParent.set(reply.parentId, list);
        }

        const threads = topLevel
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .map((c) => {
                const replies = repliesByParent.get(c.id) || [];
                return { ...c, replies, repliesCount: replies.length };
            });

        res.json(threads);
    } catch (error) {
        console.error("Error in getCommentsByPostId:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const deleteComment = async (req, res) => {
    try {
        const { commentId } = req.params;
        const userId = req.user.id;

        if (!OBJECT_ID_REGEX.test(commentId)) {
            return res.status(400).json({ message: "Invalid Comment ID format" });
        }

        const comment = await prisma.comment.findUnique({
            where: { id: commentId }
        });

        if (!comment) {
            return res.status(404).json({ message: "Comment not found" });
        }

        if (comment.userId !== userId) {
            return res.status(403).json({ message: "You can only delete your own comments" });
        }

        // CommentReplies is NoAction, so remove the thread's replies first.
        const { count: repliesDeleted } = await prisma.comment.deleteMany({ where: { parentId: commentId } });
        await prisma.comment.delete({ where: { id: commentId } });

        res.json({ message: "Comment deleted successfully", deletedCount: repliesDeleted + 1 });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const createLike = async (req, res) => {
    try {
        const { postId } = req.params;
        const userId = req.user.id;

        if (!OBJECT_ID_REGEX.test(postId)) {
            return res.status(400).json({ message: "Invalid Post ID format" });
        }

        const post = await prisma.post.findUnique({
            where: { id: postId },
            select: { id: true, userId: true }
        });
        if (!post) {
            return res.status(404).json({ message: "Post not found" });
        }
        const notifyLike = () => createNotification({
            recipientId: post.userId,
            actorId: userId,
            type: "like",
            postId
        });

        const existingLike = await prisma.like.findUnique({
            where: {
                userId_postId: { userId, postId }
            }
        });

        if (existingLike && existingLike.isLiked) {
            await prisma.like.update({
                where: { id: existingLike.id },
                data: { isLiked: false }
            });
            await removeNotifications({ type: "like", actorId: userId, postId });
            return res.json({ message: "Post unliked", isLiked: false });
        } else if (existingLike && !existingLike.isLiked) {
            await prisma.like.update({
                where: { id: existingLike.id },
                data: { isLiked: true }
            });
            await notifyLike();
            return res.json({ message: "Post liked", isLiked: true });
        } else {
            await prisma.like.create({
                data: { userId, postId, isLiked: true }
            });
            await notifyLike();
            return res.json({ message: "Post liked", isLiked: true });
        }
    } catch (error) {
        console.error("Error in createLike:", error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getLikesCount = async (req, res) => {
    try {
        const { postId } = req.params;
        const count = await prisma.like.count({
            where: { postId, isLiked: true }
        });
        res.json({ likesCount: count });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const getUsersWhoLikedPost = async (req, res) => {
    try {
        const { postId } = req.params;
        const likes = await prisma.like.findMany({
            where: { postId, isLiked: true },
            include: {
                user: {
                    select: {
                        id: true,
                        firstname: true,
                        lastname: true,
                        imageUrl: true
                    }
                }
            },
            take: 10
        });

        const users = likes.map(l => ({
            id: l.user.id,
            username: `${l.user.firstname} ${l.user.lastname}`,
            avatar: l.user.imageUrl || "https://github.com/shadcn.png"
        }));

        res.json(users);
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const reportPost = async (req, res) => {
    try {
        const { postId } = req.params;
        const { reason } = req.body;
        const userId = req.user.id;

        if (!reason) {
            return res.status(400).json({ message: "Reason is required to report a post" });
        }

        const existingReport = await prisma.report.findFirst({
            where: { userId, postId }
        });

        if (existingReport) {
            return res.status(400).json({ message: "You have already reported this post" });
        }

        const report = await prisma.report.create({
            data: { reason, postId, userId }
        });

        res.json({ message: "Post reported successfully", report });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const reportComment = async (req, res) => {
    try {
        const { commentId } = req.params;
        const { reason } = req.body;
        const userId = req.user.id;

        if (!reason) {
            return res.status(400).json({ message: "Reason is required to report a comment" });
        }

        const existingReport = await prisma.report.findFirst({
            where: { userId, commentId }
        });

        if (existingReport) {
            return res.status(400).json({ message: "You have already reported this comment" });
        }

        const report = await prisma.report.create({
            data: { reason, commentId, userId }
        });

        res.json({ message: "Comment reported successfully", report });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

module.exports = {
    addComment,
    getCommentsByPostId,
    deleteComment,
    createLike,
    getLikesCount,
    getUsersWhoLikedPost,
    reportPost,
    reportComment
};
