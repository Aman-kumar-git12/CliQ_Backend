const { prisma } = require("../../../prisma/prismaClient");
const jwt = require("jsonwebtoken");
const {
    createEmailVerificationToken,
    createOTP,
} = require("../../utils/emailVerificationUtils");
const { sendVerificationEmail, sendOTPEmail } = require("../../utils/mailUtils");

const MAX_UNBLOCK_REQUESTS_PER_ACCOUNT = 5;
const UNBLOCK_REQUEST_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_VERIFICATION_RESENDS = 3;
const VERIFICATION_RESEND_COOLDOWN_MS = 10 * 60 * 1000;

const normalizeEmail = (email) => String(email || "").trim().toLowerCase();

const createAuthToken = (user) =>
    jwt.sign(
        { userId: user.id, email: user.email },
        process.env.JWT_SECRET_KEY,
        { expiresIn: "24h" }
    );

const setAuthCookie = (res, token) => {
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: 24 * 60 * 60 * 1000,
    });
};

const sendFreshOTP = async (user) => {
    await prisma.verificationToken.deleteMany({
        where: { userId: user.id, type: "email_verification" },
    });

    const { otp, otpHash, expiresAt } = createOTP();

    await prisma.verificationToken.create({
        data: {
            userId: user.id,
            tokenHash: otpHash,
            expiresAt,
            type: "email_verification",
        },
    });

    await sendOTPEmail({ email: user.email, firstname: user.firstname, otp });
};

const sendFreshVerificationEmail = async (user) => {
    await prisma.verificationToken.deleteMany({
        where: { userId: user.id, type: "email_verification" },
    });

    const { token, tokenHash, expiresAt } = createEmailVerificationToken();

    await prisma.verificationToken.create({
        data: {
            userId: user.id,
            tokenHash,
            expiresAt,
            type: "email_verification",
        },
    });

    await sendVerificationEmail({ email: user.email, firstname: user.firstname, token });
};

module.exports = {
    MAX_UNBLOCK_REQUESTS_PER_ACCOUNT,
    UNBLOCK_REQUEST_COOLDOWN_MS,
    MAX_VERIFICATION_RESENDS,
    VERIFICATION_RESEND_COOLDOWN_MS,
    normalizeEmail,
    createAuthToken,
    setAuthCookie,
    sendFreshOTP,
    sendFreshVerificationEmail
};
