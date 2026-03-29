const { prisma } = require("../../../prisma/prismaClient");
const { toSafeUser } = require("../../utils/authUtils");
const { hashVerificationToken, hashOTP } = require("../../utils/emailVerificationUtils");
const {
    normalizeEmail,
    createAuthToken,
    setAuthCookie,
    sendFreshOTP,
    MAX_VERIFICATION_RESENDS,
    VERIFICATION_RESEND_COOLDOWN_MS
} = require("./authHelpers");

const verifyEmail = async (req, res) => {
    try {
        const token = String(req.query?.token || req.body?.token || "").trim();

        if (!token) {
            return res.status(400).json({ message: "Verification token is required." });
        }

        const tokenHash = hashVerificationToken(token);
        const verificationRecord = await prisma.verificationToken.findUnique({
            where: { tokenHash },
            include: { user: true },
        });

        if (!verificationRecord || verificationRecord.type !== "email_verification") {
            return res.status(400).json({ message: "Invalid verification token." });
        }

        if (verificationRecord.expiresAt.getTime() < Date.now()) {
            await prisma.verificationToken.delete({
                where: { id: verificationRecord.id },
            });
            return res.status(400).json({ message: "Verification token has expired. Please request a new one." });
        }

        const user = await prisma.users.update({
            where: { id: verificationRecord.userId },
            data: { emailVerified: true },
        });

        await prisma.verificationToken.deleteMany({
            where: {
                userId: verificationRecord.userId,
                type: "email_verification",
            },
        });

        const authToken = createAuthToken(user);
        setAuthCookie(res, authToken);

        return res.json({
            message: "Email verified successfully.",
            user: toSafeUser(user),
        });
    } catch (err) {
        return res.status(500).json({
            message: "Internal server error",
            error: err.message,
        });
    }
};

const resendVerificationEmail = async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);

        if (!email) {
            return res.status(400).json({ message: "Email is required." });
        }

        const user = await prisma.users.findUnique({
            where: { email },
            select: {
                id: true,
                firstname: true,
                email: true,
                emailVerified: true,
                authProvider: true,
            },
        });

        if (!user) {
            return res.status(404).json({ message: "No account found with this email." });
        }

        if (user.authProvider === "google") {
            return res.status(400).json({ message: "This account uses Google sign-in and does not require email verification." });
        }

        if (user.emailVerified) {
            return res.status(400).json({ message: "This email is already verified." });
        }

        const existingTokens = await prisma.verificationToken.findMany({
            where: { userId: user.id, type: "email_verification" },
            orderBy: { createdAt: "desc" },
            select: { id: true, createdAt: true },
        });

        if (existingTokens.length >= MAX_VERIFICATION_RESENDS) {
            return res.status(429).json({
                message: `You have reached the maximum of ${MAX_VERIFICATION_RESENDS} verification codes for this account. Please contact support if you still need help.`,
            });
        }

        const latestToken = existingTokens[0];
        if (latestToken) {
            const nextAllowedTime = new Date(latestToken.createdAt).getTime() + VERIFICATION_RESEND_COOLDOWN_MS;
            const remainingMs = nextAllowedTime - Date.now();

            if (remainingMs > 0) {
                const remainingSeconds = Math.ceil(remainingMs / 1000);
                const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
                const display = remainingSeconds < 60
                    ? `${remainingSeconds} second${remainingSeconds === 1 ? "" : "s"}`
                    : `${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`;
                return res.status(429).json({
                    message: `Please wait ${display} before requesting a new code.`,
                    remainingMs,
                });
            }
        }

        await sendFreshOTP(user);

        return res.json({ message: "A new verification code has been sent to your email." });
    } catch (err) {
        return res.status(500).json({
            message: "Internal server error",
            error: err.message,
        });
    }
};

const verifyOTP = async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const otp = String(req.body?.otp || "").trim();

        if (!email || !otp) {
            return res.status(400).json({ message: "Email and OTP are required." });
        }

        if (!/^\d{6}$/.test(otp)) {
            return res.status(400).json({ message: "OTP must be a 6-digit number." });
        }

        const user = await prisma.users.findUnique({ where: { email } });

        if (!user) {
            return res.status(404).json({ message: "No account found with this email." });
        }

        if (user.emailVerified) {
            const authToken = createAuthToken(user);
            setAuthCookie(res, authToken);
            return res.json({ message: "Email already verified.", user: toSafeUser(user) });
        }

        const otpHash = hashOTP(otp);

        const record = await prisma.verificationToken.findUnique({
            where: { tokenHash: otpHash },
        });

        if (!record || record.userId !== user.id || record.type !== "email_verification") {
            return res.status(400).json({ message: "Invalid verification code. Please check and try again." });
        }

        if (record.expiresAt.getTime() < Date.now()) {
            await prisma.verificationToken.delete({ where: { id: record.id } });
            return res.status(400).json({
                message: "This code has expired. Please request a new one.",
                code: "OTP_EXPIRED",
            });
        }

        const updatedUser = await prisma.users.update({
            where: { id: user.id },
            data: { emailVerified: true },
        });

        await prisma.verificationToken.deleteMany({
            where: { userId: user.id, type: "email_verification" },
        });

        const authToken = createAuthToken(updatedUser);
        setAuthCookie(res, authToken);

        return res.json({
            message: "Email verified successfully!",
            user: toSafeUser(updatedUser),
        });
    } catch (err) {
        return res.status(500).json({
            message: "Internal server error",
            error: err.message,
        });
    }
};

module.exports = { verifyEmail, resendVerificationEmail, verifyOTP };
