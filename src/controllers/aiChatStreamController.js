const crypto = require("crypto");
const { prisma } = require("../../prisma/prismaClient");
const redisClient = require("../config/redisClient");

const llmServiceUrl = process.env.LLM_SERVICE_URL || "http://localhost:8000";
const CACHE_TTL_SECONDS = 24 * 60 * 60;
const MAX_QUESTION_CHARS = 1000;
const FALLBACK_ANSWER = "Sorry, something went wrong on my side. Please try asking that again in a moment.";

// ---------- helpers ----------

const normalizeQuestion = (text) =>
    String(text || "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[?!.。\s]+$/u, "")
        .trim();

const KB_VERSION_TTL_MS = 60 * 1000;
let kbVersionMemo = { value: null, fetchedAt: 0 };

// The agent's fingerprint of its knowledge files, so editing the docs retires old cached answers automatically
const getKbVersion = async () => {
    if (kbVersionMemo.value && Date.now() - kbVersionMemo.fetchedAt < KB_VERSION_TTL_MS) return kbVersionMemo.value;
    try {
        const response = await fetch(`${llmServiceUrl}/api/chat/kb-version`, { signal: AbortSignal.timeout(3000) });
        const { kbVersion } = response.ok ? await response.json() : {};
        if (kbVersion) kbVersionMemo = { value: String(kbVersion), fetchedAt: Date.now() };
        return kbVersion ? String(kbVersion) : null;
    } catch {
        return null;
    }
};

// Returns null when the knowledge-base version is unknown; the cache is then skipped rather than risk stale answers
const buildCacheKey = async (question) => {
    const kbVersion = await getKbVersion();
    if (!kbVersion) return null;
    const hash = crypto.createHash("sha1").update(normalizeQuestion(question)).digest("hex");
    return `aichat:kb${kbVersion}:${hash}`;
};

const hasText = (value) => {
    if (Array.isArray(value)) return value.some(hasText);
    if (value && typeof value === "object") return Object.values(value).some(hasText);
    return typeof value === "string" ? value.trim().length > 0 : value != null;
};

const isExpertiseFilled = (expertise) => {
    if (!expertise || typeof expertise !== "object") return false;
    return ["skills", "aboutYou", "description", "experience", "projects"].some((key) => hasText(expertise[key]));
};

// Only non-identifying facts go to the LLM: no email, password or IDs
const buildUserContext = async (user) => {
    const [pendingRequests, unreadNotifications] = await Promise.all([
        prisma.connectionsRequest.count({ where: { toUserId: user.id, status: "interested" } }),
        prisma.notification.count({ where: { recipientId: user.id, isRead: false } }),
    ]);
    return {
        firstname: user.firstname,
        pendingRequests,
        unreadNotifications,
        expertiseFilled: isExpertiseFilled(user.expertise),
    };
};

const writeEvent = (res, event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

// Parses an SSE byte stream into { event, data } objects
async function* readSseEvents(body) {
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    for await (const chunk of body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
            const rawEvent = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            let event = "message";
            const dataLines = [];
            for (const line of rawEvent.split("\n")) {
                if (line.startsWith("event:")) event = line.slice(6).trim();
                else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
            }
            if (!dataLines.length) continue;
            try {
                yield { event, data: JSON.parse(dataLines.join("\n")) };
            } catch {
                // Ignore malformed events instead of breaking the whole answer
            }
        }
    }
}

const readCache = async (key) => {
    if (!key) return null;
    try {
        if (!(await redisClient.ensureReady())) return null;
        const cached = await redisClient.get(key);
        return cached ? JSON.parse(cached) : null;
    } catch (error) {
        console.error("AI chat cache read failed:", error.message);
        return null;
    }
};

const writeCache = async (key, value) => {
    if (!key) return;
    try {
        if (!(await redisClient.ensureReady())) return;
        await redisClient.set(key, JSON.stringify(value), { EX: CACHE_TTL_SECONDS });
    } catch (error) {
        console.error("AI chat cache write failed:", error.message);
    }
};

// Keeps the agent's own conversation memory in sync when the answer came from the cache
const appendAgentHistory = (sessionId, question, answer) =>
    fetch(`${llmServiceUrl}/api/chat/history/append`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, question, answer }),
    }).catch((error) => console.error("Agent history append failed:", error.message));

// Splits cached text into small word-sized tokens so it streams like a live answer
const tokenize = (text) => text.match(/\S+\s*|\s+/g) || [];

const saveUserMessage = async (session, text) => {
    const data = { updatedAt: new Date() };
    if (session.title === "New Chat") {
        data.title = text.substring(0, 30) + (text.length > 30 ? "..." : "");
    }
    await prisma.aIChatSession.update({ where: { id: session.id }, data });
    return prisma.aIChatMessage.create({ data: { sessionId: session.id, role: "user", text } });
};

// ---------- POST /aichat/stream ----------

const streamChat = async (req, res) => {
    const startedAt = Date.now();
    const userId = req.user.id;
    const { sessionId, currentPath } = req.body || {};
    const regenerate = req.body?.regenerate === true;
    let message = typeof req.body?.message === "string" ? req.body.message.trim() : "";

    if (!sessionId || (!regenerate && !message)) {
        return res.status(400).json({ error: "Missing sessionId or message" });
    }
    if (message.length > MAX_QUESTION_CHARS) {
        return res.status(400).json({ error: `Message must be ${MAX_QUESTION_CHARS} characters or fewer` });
    }

    let session;
    try {
        session = await prisma.aIChatSession.findFirst({ where: { id: sessionId, userId, isDeleted: false } });
    } catch {
        session = null;
    }
    if (!session) return res.status(404).json({ error: "Session not found" });

    let isFirstQuestion = false;
    try {
        if (regenerate) {
            // Regenerate answers the last user question again and replaces the AI reply after it
            const [lastUser] = await prisma.aIChatMessage.findMany({
                where: { sessionId, role: "user" },
                orderBy: { createdAt: "desc" },
                take: 1,
            });
            if (!lastUser) return res.status(400).json({ error: "Nothing to regenerate" });
            message = lastUser.text;
            await prisma.aIChatMessage.deleteMany({
                where: { sessionId, role: "ai", createdAt: { gt: lastUser.createdAt } },
            });
        } else {
            await saveUserMessage(session, message);
            const userMessageCount = await prisma.aIChatMessage.count({ where: { sessionId, role: "user" } });
            isFirstQuestion = userMessageCount === 1;
        }
    } catch (error) {
        console.error("AI chat stream setup failed:", error);
        return res.status(500).json({ error: "Could not start AI chat" });
    }

    res.status(200).set({
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    // Stop the upstream LLM request as soon as the user presses Stop or closes the tab
    const upstream = new AbortController();
    let clientGone = false;
    res.on("close", () => {
        if (!res.writableEnded) {
            clientGone = true;
            upstream.abort();
        }
    });

    const cacheKey = isFirstQuestion ? await buildCacheKey(message) : null;
    let answer = "";
    let suggestions = [];
    let agentMeta = {};
    let cached = false;
    let errorCode = null;

    try {
        const hit = isFirstQuestion ? await readCache(cacheKey) : null;
        if (hit?.answer) {
            cached = true;
            answer = hit.answer;
            suggestions = hit.suggestions || [];
            agentMeta = { cacheable: true, sources: hit.sources || [], language: hit.language };
            for (const text of tokenize(answer)) writeEvent(res, "token", { text });
            appendAgentHistory(sessionId, message, answer);
        } else {
            const userContext = await buildUserContext(req.user);
            const response = await fetch(`${llmServiceUrl}/api/chat/stream`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message, sessionId, currentPath, userContext, regenerate }),
                signal: upstream.signal,
            });
            if (!response.ok || !response.body) throw new Error(`Agent responded with ${response.status}`);

            for await (const { event, data } of readSseEvents(response.body)) {
                if (event === "token") {
                    answer += data.text || "";
                    writeEvent(res, "token", data);
                } else if (event === "suggestions") {
                    suggestions = Array.isArray(data.items) ? data.items : [];
                } else if (event === "done") {
                    agentMeta = data || {};
                } else {
                    // status and error events go straight to the client
                    if (event === "error") errorCode = data.code || "agent_error";
                    writeEvent(res, event, data);
                }
            }
        }
    } catch (error) {
        if (!clientGone) {
            errorCode = errorCode || "agent_unreachable";
            console.error("AI chat stream failed:", error.message);
            if (!answer) {
                answer = FALLBACK_ANSWER;
                writeEvent(res, "token", { text: FALLBACK_ANSWER });
            }
        }
    }

    let savedMessage = null;
    if (answer) {
        // Kept with the answer so a later 👍/👎 can teach the agent which question and docs it was about
        const meta = {
            question: message,
            sources: Array.isArray(agentMeta.sources) ? agentMeta.sources : [],
            language: agentMeta.language || null,
            cacheable: Boolean(agentMeta.cacheable) && !errorCode && !clientGone,
            error: Boolean(errorCode),
        };
        try {
            savedMessage = await prisma.aIChatMessage.create({ data: { sessionId, role: "ai", text: answer, meta } });
        } catch (error) {
            console.error("Saving AI answer failed:", error.message);
        }
    }

    if (!cached && !clientGone && !errorCode && isFirstQuestion && agentMeta.cacheable && answer) {
        await writeCache(cacheKey, { answer, suggestions, sources: agentMeta.sources || [], language: agentMeta.language });
    }

    if (!clientGone) {
        if (suggestions.length) writeEvent(res, "suggestions", { items: suggestions });
        writeEvent(res, "done", { messageId: savedMessage?.id || null, cached });
        res.end();
    }

    // Cache hits never reach the agent, so the backend logs them in the same JSON shape
    if (cached) {
        console.log(JSON.stringify({
            event: "aichat",
            source: "cache",
            session: crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 12),
            latency_ms: Date.now() - startedAt,
            cached: true,
        }));
    }
};

// ---------- feedback learning ----------

let missingKeyLogged = false;

// Sends a 👍/👎 to the agent so it can reuse approved answers and avoid rejected ones
const forwardFeedback = (message, feedback, userId) => {
    const meta = message.meta || {};
    if (!meta.question || meta.error) return; // nothing to learn from failed or legacy answers
    if (!process.env.AGENT_INTERNAL_KEY) {
        if (!missingKeyLogged) console.warn("AGENT_INTERNAL_KEY is not set; AI feedback learning is disabled.");
        missingKeyLogged = true;
        return;
    }
    fetch(`${llmServiceUrl}/api/chat/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Internal-Key": process.env.AGENT_INTERNAL_KEY },
        body: JSON.stringify({
            messageId: message.id,
            // One vote per user is counted, but the agent never sees the real user id
            userHash: crypto.createHash("sha256").update(String(userId)).digest("hex").slice(0, 16),
            rating: feedback,
            question: meta.question,
            answer: message.text,
            language: meta.language || null,
            sources: Array.isArray(meta.sources) ? meta.sources : [],
            cacheable: Boolean(meta.cacheable),
        }),
    })
        .then((response) => {
            if (!response.ok) console.error("Agent rejected feedback:", response.status);
        })
        .catch((error) => console.error("Forwarding feedback failed:", error.message));
};

// A 👎 answer must not keep being served from the shared cache
const evictCachedAnswer = async (question) => {
    try {
        const key = await buildCacheKey(question);
        if (key && (await redisClient.ensureReady())) await redisClient.del(key);
    } catch (error) {
        console.error("AI chat cache evict failed:", error.message);
    }
};

// ---------- PATCH /aichat/message/:id/feedback ----------

const setFeedback = async (req, res) => {
    try {
        const { id } = req.params;
        const { feedback, note } = req.body || {};

        if (![1, -1, null].includes(feedback)) {
            return res.status(400).json({ error: "feedback must be 1, -1 or null" });
        }
        if (note != null && (typeof note !== "string" || note.length > 500)) {
            return res.status(400).json({ error: "note must be a string of 500 characters or fewer" });
        }
        if (!/^[a-f0-9]{24}$/i.test(id)) return res.status(404).json({ error: "Message not found" });

        const message = await prisma.aIChatMessage.findUnique({
            where: { id },
            include: { session: { select: { userId: true, isDeleted: true } } },
        });
        if (!message || message.session.isDeleted || message.session.userId !== req.user.id) {
            return res.status(404).json({ error: "Message not found" });
        }
        if (message.role !== "ai") return res.status(400).json({ error: "Only AI messages can be rated" });

        const updated = await prisma.aIChatMessage.update({
            where: { id },
            data: { feedback, feedbackNote: feedback === null ? null : (note?.trim() || null) },
            select: { id: true, feedback: true, feedbackNote: true },
        });
        res.status(200).json({ message: updated });

        // Only a changed rating teaches the agent (adding a note to an existing 👎 doesn't)
        if (message.feedback !== feedback) {
            forwardFeedback(message, feedback, req.user.id);
            if (feedback === -1 && message.meta?.question) await evictCachedAnswer(message.meta.question);
        }
    } catch (error) {
        console.error("Error saving AI chat feedback:", error);
        res.status(500).json({ error: "Could not save feedback" });
    }
};

module.exports = { streamChat, setFeedback };
