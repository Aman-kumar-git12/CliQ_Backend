const express = require("express");
const chatRouter = express.Router();
const chatController = require("../controllers/chatController");
const { userAuth } = require("../middlewares/authMiddleware");

chatRouter.get("/chat/conversations", userAuth, chatController.getConversations);
chatRouter.get("/chat/history/:targetuserId", userAuth, chatController.getChatHistory);
chatRouter.delete("/chat/message/:messageId", userAuth, chatController.deleteMessage);
chatRouter.put("/chat/message/:messageId", userAuth, chatController.updateMessage);
chatRouter.delete("/chat/conversation/:targetUserId", userAuth, chatController.hideConversation);

module.exports = chatRouter;
