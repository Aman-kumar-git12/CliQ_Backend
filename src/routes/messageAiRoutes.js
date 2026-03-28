const express = require("express");
const messageAiRouter = express.Router();
const chatAssistantController = require("../controllers/chatAssistantController");
const { userAuth } = require("../middlewares/authMiddleware");

messageAiRouter.post("/message-ai/conversation/:targetuserId", userAuth, chatAssistantController.getMessageAssistant);
messageAiRouter.post("/message-ai/conversation/stream/:targetuserId", userAuth, chatAssistantController.streamMessageAssistant);
messageAiRouter.get("/message-ai/history/:targetuserId", userAuth, chatAssistantController.getMessageAssistantHistory);
messageAiRouter.post("/message-ai/history/:targetuserId", userAuth, chatAssistantController.saveMessageAssistantHistory);
messageAiRouter.delete("/message-ai/history/:targetuserId", userAuth, chatAssistantController.clearMessageAssistantHistory);
messageAiRouter.delete("/message-ai/history/:targetuserId/:historyId", userAuth, chatAssistantController.deleteMessageAssistantHistoryItem);
messageAiRouter.get("/message-ai/ask-history/:targetuserId", userAuth, chatAssistantController.getMessageAssistantAskHistory);
messageAiRouter.post("/message-ai/ask-history/:targetuserId", userAuth, chatAssistantController.saveMessageAssistantAskHistory);
messageAiRouter.delete("/message-ai/ask-history/:targetuserId", userAuth, chatAssistantController.clearMessageAssistantAskHistory);
messageAiRouter.delete("/message-ai/ask-history/:targetuserId/:historyId", userAuth, chatAssistantController.deleteMessageAssistantAskHistoryItem);

module.exports = messageAiRouter;
