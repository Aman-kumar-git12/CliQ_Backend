const { prisma } = require("../../../prisma/prismaClient");
const bcrypt = require("bcrypt");
const { toSafeUser } = require("../../utils/auth/authUtils");
const { createOTP, consumeOTP } = require("../../utils/auth/emailVerificationUtils");
const { sendPasswordResetEmail } = require("../../utils/auth/mailUtils");
const { startSession, endAllSessions } = require("./authHelpers");

const forgotPassword = async (req, res) => {
    const { email } = req.body;

    const user = await prisma.users.findUnique({ where: { email } });
    if (!user) {
        return res.json({ message: "If an account exists, a password reset code has been sent." });
    }

    // Same answer as an unknown address, so the reply doesn't reveal which emails have accounts
    if (user.authProvider === "google") {
        return res.json({ message: "If an account exists, a password reset code has been sent." });
    }

    await prisma.verificationToken.deleteMany({
        where: { userId: user.id, type: "password_reset" },
    });

    const { otp, otpHash, expiresAt } = createOTP(user.id);

    await prisma.verificationToken.create({
        data: {
            userId: user.id,
            tokenHash: otpHash,
            expiresAt,
            type: "password_reset",
        },
    });

    await sendPasswordResetEmail({ email: user.email, firstname: user.firstname, otp });

    return res.json({ message: "If an account exists, a password reset code has been sent." });
};

const resetPassword = async (req, res) => {
    const { email, otp, newPassword } = req.body;

    const user = await prisma.users.findUnique({ where: { email } });
    if (!user) {
        return res.status(400).json({ message: "Invalid or expired reset code." });
    }

    await consumeOTP(prisma, { userId: user.id, type: "password_reset", otp });

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    const updatedUser = await prisma.users.update({
        where: { id: user.id },
        data: {
            password: hashedPassword,
            emailVerified: true,
            // Ends every session signed in with the old password
            tokenVersion: { increment: 1 },
        },
    });
    await endAllSessions(user.id);
    await startSession(res, updatedUser);

    return res.json({
        message: "Password reset correctly. You are now logged in.",
        user: toSafeUser(updatedUser),
    });
};

module.exports = { forgotPassword, resetPassword };
