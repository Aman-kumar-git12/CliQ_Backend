const { prisma } = require("../../../prisma/prismaClient");
const bcrypt = require("bcrypt");
const { uploadBuffer } = require("../../upload/cloudinary");
const { toSafeUser } = require("../../utils/auth/authUtils");
const { config } = require("../../config");
const { createAuthToken, setAuthCookie } = require("../auth/authHelpers");

const getProfile = async (req, res) => {
    const user = req.user;

    // Connections Count
    const connectionCount = await prisma.connectionsRequest.count({
        where: {
            status: "accepted",
            OR: [{ fromUserId: user.id }, { toUserId: user.id }],
        },
    });

    // Posts Count
    const postsCount = await prisma.post.count({
        where: { userId: user.id },
    });

    // Groups Count
    const groupsCount = await prisma.conversation.count({
        where: {
            isGroup: true,
            participantIds: { has: user.id },
        },
    });

    // Attach counts to user object for frontend consumption
    const userWithStats = {
        ...user,
        postsCount,
        connectionsCount: connectionCount,
        groupsCount,
    };

    res.json({ message: "User profile fetched successfully", user: userWithStats });
};

const editProfile = async (req, res) => {
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
        // Ends every other session; this browser gets a fresh cookie below
        updateData.tokenVersion = { increment: 1 };
    }

    const data = await prisma.users.update({
        where: { id: loggedInUser.id },
        data: updateData,
    });
    if (req.body.password) setAuthCookie(res, createAuthToken(data));
    res.json({ message: "Profile updated successfully", user: toSafeUser(data) });
};

const deleteProfile = async (req, res) => {
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
        secure: config.isProduction,
        sameSite: config.isProduction ? "none" : "lax",
    });

    return res.json({ message: "Profile deleted successfully" });
};

const updateProfileImage = async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ message: "No image file uploaded" });
    }

    const uploadedImage = await uploadBuffer(req.file, { folder: "profile_images" });

    const user = await prisma.users.update({
        where: { id: req.user.id },
        data: { imageUrl: uploadedImage.secure_url },
    });

    res.json({
        message: "Profile image updated",
        imageUrl: user.imageUrl,
    });
};

module.exports = {
    getProfile,
    editProfile,
    deleteProfile,
    updateProfileImage,
};
