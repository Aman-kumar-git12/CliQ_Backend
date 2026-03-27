const { prisma } = require("../../prisma/prismaClient");
const axios = require("axios");
const { clearRecommendationCacheForUser, precomputeProfileEmbedding } = require("./recommendationActionController");

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
    try {
        const userId = req.user.id;
        const { name, description, experience, skills, projects, achievements, interests, aboutYou, details, format } =
            req.body;

        const expertiseObj = buildExpertisePayload({
            name, description, experience, skills, projects, achievements, interests, aboutYou, details, format,
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
    } catch (error) {
        return res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
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

        const AGENT_URL = process.env.LLM_SERVICE_URL || "http://localhost:8000";

        const response = await axios.post(`${AGENT_URL}/api/expertise/generate`, {
            user_info: {
                firstname: user.firstname,
                lastname: user.lastname,
                email: user.email,
                imageUrl: user.imageUrl || "",
            },
            answers: aiAnswers,
            existing_expertise: {},
            mode: "fresh",
        });

        return res.json({
            message: "Expertise generated successfully",
            expertise: response.data.expertise,
            generation_source: response.data.generation_source,
        });
    } catch (error) {
        console.error("AI Generation Error:", error.message);
        return res.status(500).json({
            message: "Failed to generate expertise using AI",
            error: error.message,
        });
    }
};

module.exports = {
    updateExpertise,
    generateAIExpertise,
};
