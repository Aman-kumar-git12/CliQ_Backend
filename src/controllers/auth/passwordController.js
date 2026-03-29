const { prisma } = require("../../../prisma/prismaClient");
const bcrypt = require("bcrypt");
const { toSafeUser } = require("../../utils/authUtils");
const { createOTP, hashOTP } = require("../../utils/emailVerificationUtils");
const { sendPasswordResetEmail } = require("../../utils/mailUtils");
const { normalizeEmail, createAuthToken, setAuthCookie } = require("./authHelpers");

const forgotPassword = async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        if (!email) return res.status(400).json({ message: "Email is required." });

        const user = await prisma.users.findUnique({ where: { email } });
        if (!user) {
            return res.json({ message: "If an account exists, a password reset code has been sent." });
        }

        if (user.authProvider === "google") {
            return res.status(400).json({ message: "This account uses Google sign-in. Password reset is not available." });
        }

        await prisma.verificationToken.deleteMany({
            where: { userId: user.id, type: "password_reset" },
        });

        const { otp, otpHash, expiresAt } = createOTP();

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
    } catch (err) {
        return res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const resetPassword = async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const otp = String(req.body?.otp || "").trim();
        const newPassword = req.body?.newPassword;

        if (!email || !otp || !newPassword) {
            return res.status(400).json({ message: "Email, OTP, and new password are required." });
        }

        if (newPassword.length < 8) {
            return res.status(400).json({ message: "New password must be at least 8 characters long." });
        }

        const user = await prisma.users.findUnique({ where: { email } });
        if (!user) {
            return res.status(404).json({ message: "Account not found." });
        }

        const otpHash = hashOTP(otp);
        const record = await prisma.verificationToken.findUnique({
            where: { tokenHash: otpHash },
        });

        if (!record || record.userId !== user.id || record.type !== "password_reset") {
            return res.status(400).json({ message: "Invalid or expired reset code." });
        }

        if (record.expiresAt.getTime() < Date.now()) {
            await prisma.verificationToken.delete({ where: { id: record.id } });
            return res.status(400).json({ message: "This code has expired. Please request a new one.", code: "OTP_EXPIRED" });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        const updatedUser = await prisma.users.update({
            where: { id: user.id },
            data: {
                password: hashedPassword,
                emailVerified: true
            },
        });

        await prisma.verificationToken.deleteMany({
            where: { userId: user.id, type: "password_reset" },
        });

        const authToken = createAuthToken(updatedUser);
        setAuthCookie(res, authToken);

        return res.json({
            message: "Password reset correctly. You are now logged in.",
            user: toSafeUser(updatedUser),
        });
    } catch (err) {
        return res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

module.exports = { forgotPassword, resetPassword };
