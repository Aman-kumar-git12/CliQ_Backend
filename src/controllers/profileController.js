const { prisma } = require("../../prisma/prismaClient");
const bcrypt = require("bcrypt");
const cloudinary = require("../upload/cloudinary");
const axios = require("axios");
const redisClient = require("../config/redisClient");

const getRecommendationCacheKey = (userId) => `smart_recommendations:v3:${userId}`;

const clearRecommendationCacheForUser = async (userId) => {
    if (!userId) return;

    try {
        if (redisClient?.isReady) {
            await redisClient.del(getRecommendationCacheKey(userId));
        }
    } catch (error) {
        console.error("Failed to clear recommendation cache:", error.message);
    }
};

const precomputeProfileEmbedding = (userId, expertise) => {
    const agentUrl = process.env.LLM_SERVICE_URL || "http://localhost:8000";

    Promise.resolve()
        .then(() =>
            axios.post(
                `${agentUrl}/api/match/precompute`,
                {
                    profileId: userId,
                    profile: expertise || {},
                },
                {
                    timeout: 2000,
                }
            )
        )
        .catch((error) => {
            console.error("Profile embedding precompute failed:", error.message);
        });
};

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

const getProfile = async (req, res) => {
    try {
        const user = req.user;
        
        // Connections Count
        const connectionCount = await prisma.connectionsRequest.count({
            where: {
                status: "accepted",
                OR: [{ fromUserId: user.id }, { toUserId: user.id }],
            }
        });

        // Posts Count
        const postsCount = await prisma.post.count({
            where: { userId: user.id }
        });

        // Groups Count
        const groupsCount = await prisma.conversation.count({
            where: {
                isGroup: true,
                participantIds: { has: user.id }
            }
        });

        // Attach counts to user object for frontend consumption
        const userWithStats = {
            ...user,
            postsCount,
            connectionsCount: connectionCount,
            groupsCount
        };

        res.json({ message: "User profile fetched successfully", user: userWithStats });
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const editProfile = async (req, res) => {
    try {
        const loggedInUser = req.user;
        const updateData = {};

        Object.keys(req.body).forEach((field) => {
            if (field !== "password") {
                if (field === "age") {
                    updateData[field] = parseInt(req.body[field]);
                } else {
                    updateData[field] = req.body[field];
                }
            }
        });

        if (req.body.password) {
            const hashedPassword = await bcrypt.hash(req.body.password, 10);
            updateData.password = hashedPassword;
        }

        const data = await prisma.users.update({
            where: { id: loggedInUser.id },
            data: updateData,
        });
        res.json({ message: "Profile updated successfully", user: data });
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const deleteProfile = async (req, res) => {
    try {
        const loggedInUser = req.user;

        const user = await prisma.users.findUnique({
            where: { id: loggedInUser.id },
        });

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        await prisma.users.delete({
            where: { id: loggedInUser.id },
        });

        res.clearCookie("auth_token", {
            httpOnly: true,
            secure: process.env.NODE_ENV === "production",
            sameSite: process.env.NODE_ENV === "production" ? "none" : "lax"
        });

        return res.json({ message: "Profile deleted successfully" });
    } catch (err) {
        return res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const updateProfileImage = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: "No image file uploaded" });
        }

        const uploadPromise = new Promise((resolve, reject) => {
            const stream = cloudinary.uploader.upload_stream(
                { folder: "profile_images" },
                (error, result) => {
                    if (error) reject(error);
                    else resolve(result);
                }
            );
            stream.end(req.file.buffer);
        });

        const uploadedImage = await uploadPromise;

        const user = await prisma.users.update({
            where: { id: req.user.id },
            data: { imageUrl: uploadedImage.secure_url },
        });

        res.json({
            message: "Profile image updated",
            imageUrl: user.imageUrl,
        });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const updateExpertise = async (req, res) => {
    try {
        const userId = req.user.id;
        const {
            name,
            description,
            experience,
            skills,
            projects,
            achievements,
            interests,
            aboutYou,
            details,
            format
        } = req.body;

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
            format
        });

        const updatedUser = await prisma.users.update({
            where: { id: userId },
            data: {
                expertise: expertiseObj
            }
        });

        await clearRecommendationCacheForUser(userId);
        precomputeProfileEmbedding(userId, updatedUser.expertise);

        return res.json({
            message: "Expertise saved successfully",
            expertise: updatedUser.expertise
        });
    } catch (error) {
        return res.status(500).json({
            message: "Internal Server Error",
            error: error.message
        });
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

        // Call the WebsiteAgent (FastAPI)
        // Using LLM_SERVICE_URL from .env
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
            mode: "fresh"
        });

        return res.json({
            message: "Expertise generated successfully",
            expertise: response.data.expertise,
            generation_source: response.data.generation_source
        });
    } catch (error) {
        console.error("AI Generation Error:", error.message);
        return res.status(500).json({
            message: "Failed to generate expertise using AI",
            error: error.message
        });
    }
};

module.exports = {
    getProfile,
    editProfile,
    deleteProfile,
    updateProfileImage,
    updateExpertise,
    generateAIExpertise
};
