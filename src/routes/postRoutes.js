const express = require("express");
const postRouter = express.Router();
const postController = require("../controllers/postController");
const { userAuth } = require("../middlewares/authMiddleware");
const { validatePost, validatePostUpdate } = require("../middlewares/validationMiddleware");
const upload = require("../upload/upload");

postRouter.get("/user/post", userAuth, postController.getAllPosts);
postRouter.get("/user/posts/:userId", userAuth, postController.getPostsByUserId);
postRouter.get("/user/post/:postId", userAuth, postController.getPostById);
postRouter.get("/user/post/likes/count/:postId", userAuth, postController.getLikesCount);
postRouter.post("/user/post/like/:postId", userAuth, postController.createLike);
postRouter.post("/user/post/comments/:postId", userAuth, postController.addComment);
postRouter.get("/user/post/comments/:postId", userAuth, postController.getCommentsByPostId);
postRouter.delete("/user/post/comments/:commentId", userAuth, postController.deleteComment);
postRouter.post("/create/post", userAuth, upload.single("image"), validatePost, postController.createPost);
postRouter.delete("/delete/post/:postId", userAuth, postController.deletePost);
postRouter.put("/update/post/:postId", userAuth, validatePostUpdate, postController.updatePost);
postRouter.get("/post/feed", userAuth, postController.getPostFeed);
postRouter.post("/post/feed/random", userAuth, postController.getRandomPostFeed);
postRouter.post("/user/post/report/:postId", userAuth, postController.reportPost);
postRouter.post("/user/comment/report/:commentId", userAuth, postController.reportComment);

module.exports = postRouter;
