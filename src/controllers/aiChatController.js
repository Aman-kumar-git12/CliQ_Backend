const { prisma } = require("../../prisma/prismaClient");

const getSessions = async (req, res) => {
    try {
        const userId = req.user.id;
        const sessions = await prisma.aIChatSession.findMany({
            where: { userId, isDeleted: false },
            orderBy: { updatedAt: 'desc' },
            select: { id: true, title: true, createdAt: true, updatedAt: true }
        });
        res.status(200).json({ sessions });
    } catch (error) {
        console.error("Error fetching AI chat sessions:", error);
        res.status(500).json({ error: "Could not fetch AI chat sessions" });
    }
};

const createSession = async (req, res) => {
    try {
        const userId = req.user.id;
        const session = await prisma.aIChatSession.create({
            data: {
                userId,
                title: "New Chat",
                messages: {
                    create: {
                        role: 'ai',
                        text: "Hii i am Cliq ai agent , How can i assist you 🙂?"
                    }
                }
            },
            include: {
                messages: true
            }
        });
        res.status(201).json({ session });
    } catch (error) {
        console.error("Error creating AI chat session:", error);
        res.status(500).json({ error: "Could not create AI chat session" });
    }
};

const getHistoryBySessionId = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.user.id;

        // Verify ownership
        const session = await prisma.aIChatSession.findFirst({
            where: { id: sessionId, userId, isDeleted: false }
        });
        if (!session) return res.status(404).json({ error: "Session not found" });

        const history = await prisma.aIChatMessage.findMany({
            where: { sessionId },
            orderBy: { createdAt: 'asc' }
        });

        const messages = history.map(msg => ({
            id: msg.id,
            role: msg.role,
            text: msg.text
        }));

        res.status(200).json({ messages });
    } catch (error) {
        console.error("Error fetching AI chat history:", error);
        res.status(500).json({ error: "Could not fetch AI chat history" });
    }
};

const saveMessage = async (req, res) => {
    try {
        const userId = req.user.id;
        const { sessionId, role, text } = req.body;

        if (!sessionId || !role || !text) {
            return res.status(400).json({ error: "Missing sessionId, role, or text" });
        }

        // Verify ownership
        const session = await prisma.aIChatSession.findFirst({
            where: { id: sessionId, userId, isDeleted: false }
        });
        if (!session) return res.status(403).json({ error: "Unauthorized or invalid session" });

        // Generate a title for the session based on the first user message
        if (role === 'user' && session.title === "New Chat") {
            const newTitle = text.substring(0, 30) + (text.length > 30 ? "..." : "");
            await prisma.aIChatSession.update({
                where: { id: sessionId },
                data: { title: newTitle, updatedAt: new Date() }
            });
        } else {
            // Just bump the updatedAt
            await prisma.aIChatSession.update({
                where: { id: sessionId },
                data: { updatedAt: new Date() }
            });
        }

        const message = await prisma.aIChatMessage.create({
            data: { sessionId, role, text }
        });

        res.status(201).json({ message });
    } catch (error) {
        console.error("Error saving AI chat message:", error);
        res.status(500).json({ error: "Could not save AI chat message" });
    }
};

const deleteSession = async (req, res) => {
    try {
        const { sessionId } = req.params;
        const userId = req.user.id;

        const session = await prisma.aIChatSession.findFirst({
            where: { id: sessionId, userId }
        });
        if (!session) return res.status(404).json({ error: "Session not found" });

        // Soft delete
        await prisma.aIChatSession.update({
            where: { id: sessionId },
            data: { isDeleted: true }
        });

        res.status(200).json({ success: true, message: "Session deleted" });
    } catch (error) {
        console.error("Error deleting session:", error);
        res.status(500).json({ error: "Could not delete AI chat session" });
    }
};

const deleteAllSessions = async (req, res) => {
    try {
        const userId = req.user.id;

        await prisma.aIChatSession.updateMany({
            where: { userId, isDeleted: false },
            data: { isDeleted: true }
        });

        res.status(200).json({ success: true, message: "All sessions deleted" });
    } catch (error) {
        console.error("Error deleting all sessions:", error);
        res.status(500).json({ error: "Could not delete all AI chat sessions" });
    }
};

module.exports = {
    getSessions,
    createSession,
    getHistoryBySessionId,
    saveMessage,
    deleteSession,
    deleteAllSessions
};
