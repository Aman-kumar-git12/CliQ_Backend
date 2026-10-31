const express = require("express");
const router = express.Router();
const { userAuth } = require("../middlewares/authMiddleware");
const {
    getSessions,
    createSession,
    getHistoryBySessionId,
    saveMessage,
    deleteSession,
    deleteAllSessions,
} = require("../controllers/ai/aiChatController");
const { streamChat, setFeedback } = require("../controllers/ai/aiChatStreamController");
const { validateObjectIdParam } = require("../middlewares/validationMiddleware");

for (const name of ["sessionId", "id"]) router.param(name, validateObjectIdParam);

router.get("/aichat/sessions", userAuth, getSessions);
router.post("/aichat/session", userAuth, createSession);
router.get("/aichat/history/:sessionId", userAuth, getHistoryBySessionId);
router.delete("/aichat/sessions/all", userAuth, deleteAllSessions);
router.delete("/aichat/session/:sessionId", userAuth, deleteSession);
router.post("/aichat/save", userAuth, saveMessage);
router.post("/aichat/stream", userAuth, streamChat);
router.patch("/aichat/message/:id/feedback", userAuth, setFeedback);

module.exports = router;
