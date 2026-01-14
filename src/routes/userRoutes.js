const express = require("express");
const userRouter = express.Router();
const userController = require("../controllers/userController");
const { userAuth } = require("../middlewares/authMiddleware");

userRouter.get("/user/requests", userAuth, userController.getRequests);
userRouter.get("/user/connections", userAuth, userController.getConnections);
userRouter.delete("/user/connections/cancel/:toUserId", userAuth, userController.cancelRequest);
userRouter.delete("/user/connections/unfriend/:otherUserId", userAuth, userController.unfriend);
userRouter.get("/user/feed", userAuth, userController.getFeed);

module.exports = userRouter;
