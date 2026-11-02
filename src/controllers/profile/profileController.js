const { prisma } = require("../../../prisma/prismaClient");
const bcrypt = require("bcrypt");
const { uploadBuffer } = require("../../upload/cloudinary");
const { toSafeUser } = require("../../utils/auth/authUtils");
const { createOTP, consumeOTP } = require("../../utils/auth/emailVerificationUtils");
const { sendOTPEmail } = require("../../utils/auth/mailUtils");
const { startSession, endAllSessions, clearSessionCookies } = require("../auth/authHelpers");
const logger = require("../../utils/logger");

// Counts shown on a profile card, read together
const getProfileStats = async (userId) => {
    const [connectionsCount, postsCount, groupsCount] = await Promise.all([
        prisma.connectionsRequest.count({
            where: { status: "accepted", OR: [{ fromUserId: userId }, { toUserId: userId }] },
        }),
        prisma.post.count({ where: { userId } }),
        prisma.conversation.count({ where: { isGroup: true, participantIds: { has: userId } } }),
    ]);
    return { postsCount, connectionsCount, groupsCount };
};

const getProfile = async (req, res) => {
    const user = req.user;
    // Attach counts to user object for frontend consumption
    const userWithStats = { ...user, ...(await getProfileStats(user.id)) };
    res.json({ message: "User profile fetched successfully", user: userWithStats });
};

// Name, age and photo change directly. A new password needs the current one; the email address
// changes only through requestEmailChange + confirmEmailChange, which prove the new inbox is yours.
const editProfile = async (req, res) => {
    const { password, currentPassword, ...fields } = req.body;
    const updateData = { ...fields };

    if (password) {
        const user = await prisma.users.findUnique({ where: { id: req.user.id }, select: { password: true } });
        // Google-only accounts never chose a password, so they may set one without the old one
        const needsCurrent = req.user.authProvider !== "google";
        if (needsCurrent && !(currentPassword && (await bcrypt.compare(currentPassword, user.password)))) {
            return res.status(400).json({ message: "Your current password is incorrect.", code: "WRONG_PASSWORD" });
        }
        updateData.password = await bcrypt.hash(password, 10);
        if (req.user.authProvider === "google") updateData.authProvider = "hybrid";
        // Ends every other session; this browser gets a fresh one below
        updateData.tokenVersion = { increment: 1 };
    }

    const data = await prisma.users.update({
        where: { id: req.user.id },
        data: updateData,
    });
    if (password) {
        await endAllSessions(data.id);
        await startSession(res, data);
    }
    res.json({ message: "Profile updated successfully", user: toSafeUser(data) });
};

// Step 1: send a code to the new address. Nothing changes until it is confirmed.
const requestEmailChange = async (req, res) => {
    const { newEmail, currentPassword } = req.body;
    const user = await prisma.users.findUnique({ where: { id: req.user.id } });

    if (user.authProvider !== "local") {
        return res
            .status(400)
            .json({ message: "Accounts that use Google sign-in keep the email of their Google account." });
    }
    if (!(await bcrypt.compare(currentPassword, user.password))) {
        return res.status(400).json({ message: "Your current password is incorrect.", code: "WRONG_PASSWORD" });
    }
    if (newEmail === user.email) {
        return res.status(400).json({ message: "That is already your email address." });
    }
    if (await prisma.users.findUnique({ where: { email: newEmail }, select: { id: true } })) {
        return res.status(409).json({ message: "Another account already uses this email address." });
    }

    await prisma.verificationToken.deleteMany({ where: { userId: user.id, type: "email_change" } });
    const { otp, otpHash, expiresAt } = createOTP(user.id);
    await prisma.verificationToken.create({
        data: { userId: user.id, tokenHash: otpHash, expiresAt, type: "email_change", pendingEmail: newEmail },
    });
    await sendOTPEmail({ email: newEmail, firstname: user.firstname, otp });

    res.json({ message: `We sent a 6-digit code to ${newEmail}. Enter it to confirm the change.` });
};

// Step 2: the code from the new inbox applies the change and signs out other browsers
const confirmEmailChange = async (req, res) => {
    const record = await consumeOTP(prisma, { userId: req.user.id, type: "email_change", otp: req.body.otp });

    if (await prisma.users.findUnique({ where: { email: record.pendingEmail }, select: { id: true } })) {
        return res.status(409).json({ message: "Another account already uses this email address." });
    }

    const data = await prisma.users.update({
        where: { id: req.user.id },
        data: { email: record.pendingEmail, emailVerified: true, tokenVersion: { increment: 1 } },
    });
    await endAllSessions(data.id);
    await startSession(res, data);
    res.json({ message: "Your email address has been changed.", user: toSafeUser(data) });
};

// Everything the account holds, as one JSON download (data portability)
const exportMyData = async (req, res) => {
    const userId = req.user.id;
    const [user, posts, comments, likes, savedPosts, connections, messages, aiChats, notifications] = await Promise.all(
        [
            prisma.users.findUnique({
                where: { id: userId },
                select: {
                    id: true,
                    firstname: true,
                    lastname: true,
                    email: true,
                    age: true,
                    authProvider: true,
                    emailVerified: true,
                    imageUrl: true,
                    expertise: true,
                    lastLoginAt: true,
                    createdAt: true,
                    updatedAt: true,
                },
            }),
            prisma.post.findMany({
                where: { userId },
                select: { id: true, content: true, image: true, video: true, repostOfId: true, createdAt: true },
                orderBy: { createdAt: "desc" },
            }),
            prisma.comment.findMany({
                where: { userId },
                select: { id: true, postId: true, parentId: true, comment: true, createdAt: true },
                orderBy: { createdAt: "desc" },
            }),
            prisma.like.findMany({ where: { userId }, select: { postId: true, createdAt: true } }),
            prisma.savedPost.findMany({ where: { userId }, select: { postId: true, createdAt: true } }),
            prisma.connectionsRequest.findMany({
                where: { OR: [{ fromUserId: userId }, { toUserId: userId }] },
                select: {
                    status: true,
                    createdAt: true,
                    fromUser: { select: { id: true, firstname: true, lastname: true } },
                    toUser: { select: { id: true, firstname: true, lastname: true } },
                },
            }),
            prisma.message.findMany({
                where: { senderId: userId, isDelete: false },
                select: { id: true, conversationId: true, text: true, image: true, file: true, createdAt: true },
                orderBy: { createdAt: "desc" },
            }),
            prisma.aIChatSession.findMany({
                where: { userId, isDeleted: false },
                select: {
                    title: true,
                    createdAt: true,
                    messages: { select: { role: true, text: true, createdAt: true }, orderBy: { createdAt: "asc" } },
                },
            }),
            prisma.notification.findMany({
                where: { recipientId: userId },
                select: { type: true, isRead: true, createdAt: true },
                orderBy: { createdAt: "desc" },
            }),
        ],
    );

    const date = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename="cliq-data-${date}.json"`);
    res.json({
        exportedAt: new Date().toISOString(),
        user,
        posts,
        comments,
        likes,
        savedPosts,
        connections,
        messagesSent: messages,
        aiChats,
        notifications,
    });
};

// Data keyed by the user's id without a relation, so the cascade on Users doesn't reach it: their stored
// Get Connections list and the agent's saved embedding of their profile. Best effort: the account is gone.
const removeRecommendationData = async (userId) => {
    const results = await Promise.allSettled([
        prisma.recommendationList.deleteMany({ where: { userId } }),
        prisma.$runCommandRaw({ delete: "profile_embeddings", deletes: [{ q: { _id: userId }, limit: 1 }] }),
    ]);
    for (const result of results) {
        if (result.status === "rejected") {
            logger.error("[PROFILE] Cleaning up a deleted user's recommendation data failed:", result.reason?.message);
        }
    }
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
    await removeRecommendationData(loggedInUser.id);

    clearSessionCookies(res);

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
    getProfileStats,
    getProfile,
    editProfile,
    requestEmailChange,
    confirmEmailChange,
    exportMyData,
    deleteProfile,
    updateProfileImage,
};
