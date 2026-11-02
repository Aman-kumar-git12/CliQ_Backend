const { prisma } = require("../../../prisma/prismaClient");
const axios = require("axios");
const { clearRecommendationCacheForUser, precomputeProfileEmbedding } = require("../recommendations");
const { config } = require("../../config");
const logger = require("../../utils/logger");

// ─── Sanitizers & Builders ─────────────────────────────────────────────────────

const sanitizeText = (value, fallback = "") => {
    if (typeof value !== "string") return fallback;
    const cleaned = value.trim();
    return cleaned || fallback;
};

const sanitizeSkills = (skills) => {
    if (!Array.isArray(skills)) return [];
    return [...new Set(skills.map((skill) => sanitizeText(skill)).filter(Boolean))].slice(0, 5);
};

const buildExpertisePayload = (input) => {
    const payload = {
        name: sanitizeText(input.name, "****"),
        description: sanitizeText(input.description, "****").slice(0, 50),
        experience: sanitizeText(input.experience, "****"),
        skills: sanitizeSkills(input.skills),
        projects: sanitizeText(input.projects, "****"),
        achievements: sanitizeText(input.achievements, "****"),
        interests: sanitizeText(input.interests, "****"),
        aboutYou: sanitizeText(input.aboutYou, "****"),
        details: {
            email: sanitizeText(input.details?.email, "****"),
            address: sanitizeText(input.details?.address, "****"),
        },
        format: [1, 2, 3, 4].includes(Number(input.format)) ? Number(input.format) : 1,
        updatedAt: new Date(),
    };

    if (payload.skills.length === 0) {
        payload.skills = ["****"];
    }

    return payload;
};

const buildAIAnswers = (answers = {}) => ({
    role: sanitizeText(answers.role),
    skills: sanitizeText(answers.skills),
    interests: sanitizeText(answers.interests),
    about: sanitizeText(answers.about),
    highlights: sanitizeText(answers.highlights),
    location: sanitizeText(answers.location),
});

// ─── Controllers ───────────────────────────────────────────────────────────────

const updateExpertise = async (req, res) => {
    const userId = req.user.id;
    const { name, description, experience, skills, projects, achievements, interests, aboutYou, details, format } =
        req.body;

    const expertiseObj = buildExpertisePayload({
        name,
        description,
        experience,
        skills,
        projects,
        achievements,
        interests,
        aboutYou,
        details,
        format,
    });

    const updatedUser = await prisma.users.update({
        where: { id: userId },
        data: { expertise: expertiseObj },
    });

    await clearRecommendationCacheForUser(userId);
    precomputeProfileEmbedding(userId, updatedUser.expertise);

    return res.json({
        message: "Expertise saved successfully",
        expertise: updatedUser.expertise,
    });
};

const generateAIExpertise = async (req, res) => {
    try {
        const { answers } = req.body;
        const user = req.user;

        if (!answers) {
            return res.status(400).json({ message: "No answers provided" });
        }

        const aiAnswers = buildAIAnswers(answers);
        if (!aiAnswers.about || aiAnswers.about.length < 10) {
            return res.status(400).json({ message: "Please provide a more detailed about section" });
        }

        const AGENT_URL = config.agent.url;
        // Stop the LLM call if the user leaves the page
        const controller = new AbortController();
        res.on("close", () => {
            if (!res.writableEnded) controller.abort();
        });

        const response = await axios.post(
            `${AGENT_URL}/api/expertise/generate`,
            {
                user_info: {
                    firstname: user.firstname,
                    lastname: user.lastname,
                    email: user.email,
                    imageUrl: user.imageUrl || "",
                },
                answers: aiAnswers,
                existing_expertise: {},
                mode: "fresh",
            },
            { headers: config.agent.authHeaders, timeout: config.agent.expertiseTimeoutMs, signal: controller.signal },
        );

        return res.json({
            message: "Expertise generated successfully",
            expertise: response.data.expertise,
            generation_source: response.data.generation_source,
        });
    } catch (error) {
        if (error.code === "ERR_CANCELED") return undefined; // the user left
        logger.error("AI Generation Error:", error.message);
        // The agent is down, asleep or too slow: a gateway error the page can offer to retry
        const timedOut = error.code === "ECONNABORTED" || error.code === "ETIMEDOUT";
        return res.status(timedOut ? 504 : 502).json({
            message: timedOut
                ? "The AI took too long to draft your expertise. Please try again."
                : "Failed to generate expertise using AI. Please try again in a minute.",
            code: timedOut ? "AI_TIMEOUT" : "AI_UNAVAILABLE",
        });
    }
};

module.exports = {
    updateExpertise,
    generateAIExpertise,
};
