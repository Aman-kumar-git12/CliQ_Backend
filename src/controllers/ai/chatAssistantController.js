const axios = require("axios");
const { pipeline } = require("stream/promises");
const { prisma } = require("../../../prisma/prismaClient");
const { config } = require("../../config");
const logger = require("../../utils/logger");

const llmServiceUrl = config.agent.url;

const REPLY_TIMEOUT_MS = config.messageAssistant.replyTimeoutMs;
const STREAM_TIMEOUT_MS = config.messageAssistant.streamTimeoutMs;
const ASSISTANT_RETRY_COUNT = Math.max(0, config.messageAssistant.retryCount - 1);
const MAX_CONTEXT_MESSAGES = 40;
const ASK_MODE_RECENT_MESSAGES = config.messageAssistant.askContextMessages;
const REPLY_MODE_RECENT_MESSAGES = config.messageAssistant.replyContextMessages;
const MAX_ASSISTANT_HISTORY_TURNS = config.messageAssistant.historyTurns;
const MAX_INPUT_CHARS = config.messageAssistant.maxInputChars;
const ALLOWED_TONES = new Set([
    "casual",
    "polite",
    "formal",
    "flirty",
    "professional",
    "witty",
    "direct",
    "friendly",
    "empathetic",
    "confident",
]);

const toAssistantKind = (message = {}) => {
    if (message.image) return "image";
    if (message.file && String(message.file).includes("voice_message")) return "voice";
    if (message.file) return "file";
    return "text";
};

const buildConversationContext = (messages = [], userId) =>
    messages.map((message) => ({
        role: message.senderId === userId ? "me" : "other",
        text: message.isDelete ? "This message is deleted" : message.text || "",
        kind: toAssistantKind(message),
        timestamp: message.createdAt,
    }));

const buildOlderContext = (messages = [], userId) => {
    if (!Array.isArray(messages) || messages.length === 0) return "";

    return messages
        .slice(0, 20)
        .map((message) => {
            const speaker = message.senderId === userId ? "You" : "Other person";
            const kind = toAssistantKind(message);
            const text = message.isDelete
                ? "This message is deleted"
                : message.text ||
                  (kind === "image"
                      ? "[Image]"
                      : kind === "voice"
                        ? "[Voice message]"
                        : kind === "file"
                          ? "[File]"
                          : "");
            return `${speaker}: ${text}`.trim();
        })
        .filter(Boolean)
        .join("\n")
        .slice(-1800);
};

const buildContextPreview = (messages = [], userId) => {
    if (!Array.isArray(messages) || messages.length === 0) return "No recent context available.";

    return messages
        .slice(-6)
        .map((message) => {
            const speaker = message.senderId === userId ? "You" : "Other person";
            const kind = toAssistantKind(message);
            const text = message.isDelete
                ? "This message is deleted"
                : message.text ||
                  (kind === "image"
                      ? "[Image]"
                      : kind === "voice"
                        ? "[Voice message]"
                        : kind === "file"
                          ? "[File]"
                          : "");
            return `${speaker}: ${text}`.trim();
        })
        .filter(Boolean)
        .join("\n");
};

const getLastOtherMessage = (messages = [], userId) => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.senderId !== userId) {
            const kind = toAssistantKind(message);
            return message.isDelete
                ? "This message is deleted"
                : message.text ||
                      (kind === "image"
                          ? "[Image]"
                          : kind === "voice"
                            ? "[Voice message]"
                            : kind === "file"
                              ? "[File]"
                              : "");
        }
    }
    return "";
};

const normalizeAssistantText = (value = "") =>
    String(value || "")
        .trim()
        .slice(0, MAX_INPUT_CHARS);
const normalizeAssistantTone = (value = "") => {
    const tone = String(value || "polite")
        .trim()
        .toLowerCase();
    return ALLOWED_TONES.has(tone) ? tone : "polite";
};
// The agent's emoji styles for reply suggestions (WebsiteAgent message_assistant EMOJI_INSTRUCTIONS)
const EMOJI_PREFERENCES = new Set(["both", "with", "without"]);
const normalizeEmojiPreference = (value) => {
    const preference = String(value || "")
        .trim()
        .toLowerCase();
    return EMOJI_PREFERENCES.has(preference) ? preference : "both";
};
const normalizeAssistantHistory = (history = []) =>
    (Array.isArray(history) ? history : [])
        .slice(-MAX_ASSISTANT_HISTORY_TURNS)
        .map((turn) => ({
            role: turn?.role === "user" ? "user" : "ai",
            text: normalizeAssistantText(turn?.text),
        }))
        .filter((turn) => turn.text);

const applyAssistantSafetyPolicy = ({ requestedTone, userAge, targetAge }) => {
    const tone = normalizeAssistantTone(requestedTone);
    const restrictedTones = new Set(["flirty", "romantic", "seductive"]);

    if ((userAge && userAge < 18) || (targetAge && targetAge < 18)) {
        if (restrictedTones.has(tone.toLowerCase())) {
            return {
                tone: "friendly",
                safetyNote:
                    "Romantic or flirty reply generation is limited for under-18 conversations, so the assistant used a friendly tone instead.",
            };
        }
    }

    return { tone, safetyNote: "" };
};

// Only failures that happen before the agent did any work are retried (it was restarting, or a proxy dropped
// the connection). A timeout is never retried: that would double an already long wait.
const shouldRetryAssistantError = (error) => {
    if (!error || error.code === "ERR_CANCELED") return false;
    if (["ECONNRESET", "ECONNREFUSED"].includes(error.code)) return true;
    return [502, 503].includes(Number(error?.response?.status));
};

const isTimeout = (error) => error?.code === "ECONNABORTED" || error?.code === "ETIMEDOUT";

// A short reason for the client; the full error (with the agent's address) only goes to the log
const describeAgentError = (error, timeoutMs) => {
    if (isTimeout(error)) return `timeout after ${timeoutMs}ms`;
    if (error?.response?.status) return `agent responded with ${error.response.status}`;
    return "agent unreachable";
};

// Aborts the agent call when the user closes the tab or cancels, instead of letting the LLM keep going
const abortOnClientClose = (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
        if (!res.writableEnded) controller.abort();
    });
    return controller.signal;
};

const RETRY_DELAY_MS = 300;

const postToAssistantService = async (path, payload, { timeout, responseType, signal } = {}) => {
    let lastError = null;

    for (let attempt = 0; attempt <= ASSISTANT_RETRY_COUNT; attempt += 1) {
        try {
            return await axios.post(`${llmServiceUrl}${path}`, payload, {
                timeout,
                signal,
                headers: config.agent.authHeaders,
                ...(responseType ? { responseType } : {}),
            });
        } catch (error) {
            lastError = error;
            if (attempt >= ASSISTANT_RETRY_COUNT || !shouldRetryAssistantError(error) || signal?.aborted) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
        }
    }

    throw lastError;
};

const getMessageAssistant = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { targetuserId } = req.params;
        const draft = normalizeAssistantText(req.body?.draft);
        const mode = req.body?.mode === "ask" ? "ask" : "replies";
        const question = normalizeAssistantText(req.body?.question);
        const requestedTone =
            typeof req.body?.tone === "string" && req.body.tone.trim() ? req.body.tone.trim() : "polite";
        const assistantHistory = normalizeAssistantHistory(req.body?.assistant_history);
        const recentContextLimit = mode === "ask" ? ASK_MODE_RECENT_MESSAGES : REPLY_MODE_RECENT_MESSAGES;

        const conversation = await prisma.conversation.findFirst({
            where: {
                isGroup: false,
                participantIds: { hasEvery: [userId, targetuserId] },
            },
            select: { id: true },
        });

        const [targetUser, messages] = await Promise.all([
            prisma.users.findUnique({
                where: { id: targetuserId },
                select: { firstname: true, lastname: true, age: true },
            }),
            conversation
                ? prisma.message.findMany({
                      where: {
                          conversationId: conversation.id,
                          NOT: { deletedById: { has: userId } },
                      },
                      orderBy: { createdAt: "desc" },
                      take: MAX_CONTEXT_MESSAGES,
                  })
                : Promise.resolve([]),
        ]);

        const orderedMessages = [...messages].reverse();
        const olderMessages = orderedMessages.slice(0, Math.max(0, orderedMessages.length - recentContextLimit));
        const recentMessages = orderedMessages.slice(-recentContextLimit);
        const conversationContext = buildConversationContext(recentMessages, userId);
        const olderContext = buildOlderContext(olderMessages, userId);
        const contextPreview = buildContextPreview(recentMessages, userId);
        const lastOtherMessage = getLastOtherMessage(recentMessages, userId);
        const { tone, safetyNote } = applyAssistantSafetyPolicy({
            requestedTone,
            userAge: req.user?.age,
            targetAge: targetUser?.age,
        });

        try {
            const agentResponse = await postToAssistantService(
                `/api/message-ai/respond`,
                {
                    conversation: conversationContext,
                    draft,
                    mode,
                    question,
                    older_context: olderContext,
                    assistant_history: assistantHistory,
                    tone,
                    other_name:
                        [targetUser?.firstname, targetUser?.lastname].filter(Boolean).join(" ").trim() ||
                        "the other person",
                    max_suggestions: 5,
                    emojiPreference: normalizeEmojiPreference(req.body?.emojiPreference),
                },
                { timeout: REPLY_TIMEOUT_MS, signal: abortOnClientClose(req, res) },
            );

            if (
                mode === "replies" &&
                (!Array.isArray(agentResponse.data?.reply_suggestions) ||
                    agentResponse.data.reply_suggestions.length === 0)
            ) {
                return res.status(502).json({
                    message: "Reply generation is temporarily unavailable",
                    reason: agentResponse.data?.error || "empty_reply_set",
                });
            }

            return res.status(200).json({
                source: "agent",
                contextCount: conversationContext.length,
                conversationId: conversation?.id || null,
                context_preview: contextPreview,
                last_other_message: lastOtherMessage,
                tone,
                safety_note: safetyNote || undefined,
                ...agentResponse.data,
            });
        } catch (agentError) {
            if (agentError.code === "ERR_CANCELED") return undefined; // the user left; nobody to answer
            const reason = describeAgentError(agentError, REPLY_TIMEOUT_MS);
            logger.error("Message assistant agent failed:", agentError.message);
            if (mode === "replies") {
                return res.status(502).json({
                    message: "Reply generation is temporarily unavailable",
                    reason,
                    retryable: shouldRetryAssistantError(agentError),
                });
            }
            return res.status(200).json({
                source: "fallback",
                contextCount: conversationContext.length,
                tone,
                safety_note: safetyNote || undefined,
                answer: "I could not answer from this chat right now. Please try again in a moment.",
                suggested_actions: [
                    "Try Generate Replies instead.",
                    "Ask a shorter question about the recent messages.",
                    "Ask for a summary of the conversation.",
                ],
            });
        }
    } catch (error) {
        logger.error("Message assistant failed:", error);
        return res.status(500).json({ message: "Could not generate message assistance" });
    }
};

const streamMessageAssistant = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { targetuserId } = req.params;
        const question = normalizeAssistantText(req.body?.question);
        const requestedTone =
            typeof req.body?.tone === "string" && req.body.tone.trim() ? req.body.tone.trim() : "polite";
        const assistantHistory = normalizeAssistantHistory(req.body?.assistant_history);

        const conversation = await prisma.conversation.findFirst({
            where: {
                isGroup: false,
                participantIds: { hasEvery: [userId, targetuserId] },
            },
            select: { id: true },
        });

        const [targetUser, messages] = await Promise.all([
            prisma.users.findUnique({
                where: { id: targetuserId },
                select: { firstname: true, lastname: true, age: true },
            }),
            conversation
                ? prisma.message.findMany({
                      where: {
                          conversationId: conversation.id,
                          NOT: { deletedById: { has: userId } },
                      },
                      orderBy: { createdAt: "desc" },
                      take: MAX_CONTEXT_MESSAGES,
                  })
                : Promise.resolve([]),
        ]);

        const orderedMessages = [...messages].reverse();
        const olderMessages = orderedMessages.slice(0, Math.max(0, orderedMessages.length - ASK_MODE_RECENT_MESSAGES));
        const recentMessages = orderedMessages.slice(-ASK_MODE_RECENT_MESSAGES);
        const conversationContext = buildConversationContext(recentMessages, userId);
        const olderContext = buildOlderContext(olderMessages, userId);
        const { tone } = applyAssistantSafetyPolicy({
            requestedTone,
            userAge: req.user?.age,
            targetAge: targetUser?.age,
        });

        const signal = abortOnClientClose(req, res);
        const agentResponse = await postToAssistantService(
            `/api/message-ai/respond/stream`,
            {
                conversation: conversationContext,
                mode: "ask",
                question,
                older_context: olderContext,
                assistant_history: assistantHistory,
                tone,
                other_name:
                    [targetUser?.firstname, targetUser?.lastname].filter(Boolean).join(" ").trim() ||
                    "the other person",
            },
            {
                timeout: STREAM_TIMEOUT_MS,
                responseType: "stream",
                signal,
            },
        );

        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        // pipeline (not pipe) handles the agent dropping mid-answer: an unhandled stream error would crash the
        // server. If the client leaves, the abort above stops the agent's stream as well.
        try {
            await pipeline(agentResponse.data, res);
        } catch (streamError) {
            if (!signal.aborted) logger.error("Message assistant stream broke off:", streamError.message);
            if (!res.writableEnded) res.end();
        }
    } catch (error) {
        if (error.code === "ERR_CANCELED") return; // the user left before the agent answered
        logger.error("Message assistant stream failed:", describeAgentError(error, STREAM_TIMEOUT_MS), error.message);
        if (res.headersSent) {
            if (!res.writableEnded) res.end();
            return;
        }
        res.status(502).send("I could not answer from this chat right now. Please try again in a moment.");
    }
};

const saveMessageAssistantHistory = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { targetuserId } = req.params;
        const {
            contextSummary = "",
            lastMessage = "",
            sentReply = "",
            tone = "",
            detectedIntent = "",
            topReply = "",
            generatedReplies = [],
            conversationId = null,
        } = req.body || {};

        if (!targetuserId || !String(sentReply).trim()) {
            return res.status(400).json({ message: "targetuserId and sentReply are required" });
        }

        const history = await prisma.messageAIReplyHistory.create({
            data: {
                userId,
                targetUserId: targetuserId,
                conversationId: conversationId || undefined,
                contextSummary: String(contextSummary || "No recent context available.").trim(),
                lastMessage: String(lastMessage || "").trim(),
                sentReply: String(sentReply).trim(),
                tone: String(tone || "").trim() || null,
                detectedIntent: String(detectedIntent || "").trim() || null,
                topReply: String(topReply || "").trim() || null,
                generatedReplies: Array.isArray(generatedReplies) ? generatedReplies : [],
            },
        });

        return res.status(201).json({ history });
    } catch (error) {
        logger.error("Failed to save message assistant history:", error);
        return res.status(500).json({ message: "Could not save message assistant history" });
    }
};

const getMessageAssistantHistory = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { targetuserId } = req.params;

        const history = await prisma.messageAIReplyHistory.findMany({
            where: {
                userId,
                targetUserId: targetuserId,
            },
            orderBy: { createdAt: "desc" },
            take: 20,
        });

        return res.status(200).json({ history });
    } catch (error) {
        logger.error("Failed to fetch message assistant history:", error);
        return res.status(500).json({ message: "Could not fetch message assistant history" });
    }
};

const clearMessageAssistantHistory = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { targetuserId } = req.params;

        await prisma.messageAIReplyHistory.deleteMany({
            where: {
                userId,
                targetUserId: targetuserId,
            },
        });

        return res.status(200).json({ success: true });
    } catch (error) {
        logger.error("Failed to clear message assistant history:", error);
        return res.status(500).json({ message: "Could not clear message assistant history" });
    }
};

const deleteMessageAssistantHistoryItem = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { targetuserId, historyId } = req.params;

        const history = await prisma.messageAIReplyHistory.findFirst({
            where: {
                id: historyId,
                userId,
                targetUserId: targetuserId,
            },
            select: { id: true },
        });

        if (!history) {
            return res.status(404).json({ message: "History item not found" });
        }

        await prisma.messageAIReplyHistory.delete({
            where: { id: historyId },
        });

        return res.status(200).json({ success: true, historyId });
    } catch (error) {
        logger.error("Failed to delete message assistant history item:", error);
        return res.status(500).json({ message: "Could not delete message assistant history item" });
    }
};

const saveMessageAssistantAskHistory = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { targetuserId } = req.params;
        const { question = "", answer = "", messages = [] } = req.body || {};

        const normalizedQuestion = String(question || "").trim();
        const normalizedAnswer = String(answer || "").trim();
        const normalizedMessages = Array.isArray(messages) ? messages : [];

        if (!targetuserId || !normalizedQuestion || !normalizedAnswer) {
            return res.status(400).json({ message: "targetuserId, question, and answer are required" });
        }

        const history = await prisma.messageAIAskHistory.create({
            data: {
                userId,
                targetUserId: targetuserId,
                question: normalizedQuestion,
                answer: normalizedAnswer,
                messages: normalizedMessages,
            },
        });

        return res.status(201).json({ history });
    } catch (error) {
        logger.error("Failed to save Ask AI history:", error);
        return res.status(500).json({ message: "Could not save Ask AI history" });
    }
};

const getMessageAssistantAskHistory = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { targetuserId } = req.params;

        const history = await prisma.messageAIAskHistory.findMany({
            where: {
                userId,
                targetUserId: targetuserId,
            },
            orderBy: { createdAt: "desc" },
            take: 20,
        });

        return res.status(200).json({ history });
    } catch (error) {
        logger.error("Failed to fetch Ask AI history:", error);
        return res.status(500).json({ message: "Could not fetch Ask AI history" });
    }
};

const clearMessageAssistantAskHistory = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { targetuserId } = req.params;

        await prisma.messageAIAskHistory.deleteMany({
            where: {
                userId,
                targetUserId: targetuserId,
            },
        });

        return res.status(200).json({ success: true });
    } catch (error) {
        logger.error("Failed to clear Ask AI history:", error);
        return res.status(500).json({ message: "Could not clear Ask AI history" });
    }
};

const deleteMessageAssistantAskHistoryItem = async (req, res) => {
    try {
        const userId = req.user?.id;
        const { targetuserId, historyId } = req.params;

        const history = await prisma.messageAIAskHistory.findFirst({
            where: {
                id: historyId,
                userId,
                targetUserId: targetuserId,
            },
            select: { id: true },
        });

        if (!history) {
            return res.status(404).json({ message: "Ask AI history item not found" });
        }

        await prisma.messageAIAskHistory.delete({
            where: { id: historyId },
        });

        return res.status(200).json({ success: true, historyId });
    } catch (error) {
        logger.error("Failed to delete Ask AI history item:", error);
        return res.status(500).json({ message: "Could not delete Ask AI history item" });
    }
};

module.exports = {
    getMessageAssistant,
    streamMessageAssistant,
    saveMessageAssistantHistory,
    getMessageAssistantHistory,
    clearMessageAssistantHistory,
    deleteMessageAssistantHistoryItem,
    saveMessageAssistantAskHistory,
    getMessageAssistantAskHistory,
    clearMessageAssistantAskHistory,
    deleteMessageAssistantAskHistoryItem,
};
