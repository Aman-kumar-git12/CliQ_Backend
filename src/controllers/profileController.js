const { prisma } = require("../../prisma/prismaClient");
const bcrypt = require("bcrypt");
const cloudinary = require("../upload/cloudinary");
const { toSafeUser } = require("../utils/authUtils");


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
                    const parsedAge = Number.parseInt(req.body[field], 10);
                    if (Number.isFinite(parsedAge)) {
                        updateData[field] = parsedAge;
                    }
                } else if (typeof req.body[field] === "string") {
                    updateData[field] = req.body[field].trim();
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
        res.json({ message: "Profile updated successfully", user: toSafeUser(data) });
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

module.exports = {
    getProfile,
    editProfile,
    deleteProfile,
    updateProfileImage,
};
