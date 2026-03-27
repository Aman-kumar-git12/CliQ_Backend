const express = require("express");
const chatRouter = express.Router();
const conversationController = require("../controllers/conversationController");
const messageController = require("../controllers/messageController");
const { userAuth } = require("../middlewares/authMiddleware");
const upload = require("../upload/upload");

chatRouter.get("/chat/conversations", userAuth, conversationController.getConversations);
chatRouter.get("/chat/history/:targetuserId", userAuth, conversationController.getChatHistory);
chatRouter.delete("/chat/message/:messageId", userAuth, messageController.deleteMessage);
chatRouter.put("/chat/message/:messageId", userAuth, messageController.updateMessage);
chatRouter.delete("/chat/conversation/:targetUserId", userAuth, conversationController.hideConversation);
chatRouter.post("/chat/upload", userAuth, upload.single("file"), messageController.uploadFile);
chatRouter.post("/chat/delete-bulk", userAuth, messageController.deleteMessagesBulk);
chatRouter.get("/chat/public/groups/:userId", userAuth, conversationController.getPublicUserGroups);

module.exports = chatRouter;
