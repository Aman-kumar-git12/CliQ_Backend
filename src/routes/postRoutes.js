const express = require("express");
const postRouter = express.Router();
const postCrudController = require("../controllers/posts/postCrudController");
const postFeedController = require("../controllers/posts/postFeedController");
const postInteractionController = require("../controllers/posts/postInteractionController");
const { userAuth } = require("../middlewares/authMiddleware");
const { validateObjectIdParam, validatePost, validatePostUpdate } = require("../middlewares/validationMiddleware");
const { postUpload } = require("../upload/upload");

for (const name of ["userId", "postId", "commentId"]) postRouter.param(name, validateObjectIdParam);

// CRUD
postRouter.get("/user/post", userAuth, postCrudController.getAllPosts);
postRouter.get("/user/posts/:userId", userAuth, postCrudController.getPostsByUserId);
postRouter.get("/user/post/:postId", userAuth, postCrudController.getPostById);
postRouter.post(
    "/create/post",
    userAuth,
    postUpload.fields([
        { name: "image", maxCount: 1 },
        { name: "video", maxCount: 1 },
    ]),
    validatePost,
    postCrudController.createPost,
);
postRouter.delete("/delete/post/:postId", userAuth, postCrudController.deletePost);
postRouter.put("/update/post/:postId", userAuth, validatePostUpdate, postCrudController.updatePost);

// Reposts, saved posts, link previews
postRouter.post("/user/post/repost/:postId", userAuth, postCrudController.repostPost);
postRouter.post("/user/post/save/:postId", userAuth, postCrudController.toggleSavePost);
postRouter.get("/user/saved-posts", userAuth, postCrudController.getSavedPosts);
postRouter.get("/link-preview", userAuth, postCrudController.previewLink);

// Feed
postRouter.get("/post/feed", userAuth, postFeedController.getPostFeed);
postRouter.post("/post/feed/random", userAuth, postFeedController.getRandomPostFeed);

// Interactions (likes, comments, reports)
postRouter.get("/user/post/likes/count/:postId", userAuth, postInteractionController.getLikesCount);
postRouter.get("/user/post/likes/users/:postId", userAuth, postInteractionController.getUsersWhoLikedPost);
postRouter.post("/user/post/like/:postId", userAuth, postInteractionController.createLike);
postRouter.post("/user/post/comments/:postId", userAuth, postInteractionController.addComment);
postRouter.get("/user/post/comments/:postId", userAuth, postInteractionController.getCommentsByPostId);
postRouter.delete("/user/post/comments/:commentId", userAuth, postInteractionController.deleteComment);
postRouter.post("/user/post/report/:postId", userAuth, postInteractionController.reportPost);
postRouter.post("/user/comment/report/:commentId", userAuth, postInteractionController.reportComment);

module.exports = postRouter;
