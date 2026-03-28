const formatPost = (post, currentUserId) => ({
    ...post,
    username: post.user ? `${post.user.firstname} ${post.user.lastname}` : "Anonymous",
    avatar: post.user?.imageUrl || "https://github.com/shadcn.png",
    likes: post._count?.likes ?? 0,
    comments: post._count?.comments ?? 0,
    isLiked: post.likes && post.likes.length > 0 && post.likes[0].isLiked === true,
    isReported: (post.reports && post.reports.length > 0) || false
});

const formatComment = (comment) => ({
    ...comment,
    username: comment.user ? `${comment.user.firstname} ${comment.user.lastname}` : "Anonymous",
    avatar: comment.user?.imageUrl || "https://github.com/shadcn.png",
    isReported: (comment.reports && comment.reports.length > 0) || false
});

module.exports = { formatPost, formatComment };
