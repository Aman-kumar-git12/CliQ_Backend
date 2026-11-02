const crypto = require("crypto");
const { config } = require("../../config");

// ── Token link (legacy, kept for backward compat) ────────────────────────────
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const createEmailVerificationToken = () => {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS);
    return { token, tokenHash, expiresAt };
};

const hashVerificationToken = (token) =>
    crypto
        .createHash("sha256")
        .update(String(token || ""))
        .digest("hex");

const getAllowedFrontendOrigins = () => config.frontendOrigins;

const getVerificationRedirectBaseUrl = () =>
    config.emailVerificationUrl || getAllowedFrontendOrigins()[0] || "http://localhost:5173";

const buildEmailVerificationUrl = (token) => {
    const url = new URL("/verify-email", getVerificationRedirectBaseUrl());
    url.searchParams.set("token", token);
    return url.toString();
};

// ── OTP ──────────────────────────────────────────────────────────────────────
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Wrong guesses allowed per code before it is thrown away (6 digits = 1,000,000 possibilities)
const MAX_OTP_ATTEMPTS = 5;

// The user id is mixed into the hash, so two people who happen to get the same 6 digits
// never collide on the unique tokenHash, and a hash can't be looked up without knowing whose it is.
const hashOTP = (otp, userId) =>
    crypto
        .createHash("sha256")
        .update(`${userId}:${String(otp || "").trim()}`)
        .digest("hex");

/**
 * Generate a cryptographically random 6-digit OTP for one user.
 * Returns { otp, otpHash, expiresAt }
 */
const createOTP = (userId) => {
    const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    return { otp, otpHash: hashOTP(otp, userId), expiresAt: new Date(Date.now() + OTP_TTL_MS) };
};

const otpError = (message, code) => {
    const error = new Error(message);
    error.status = 400;
    if (code) error.code = code;
    return error;
};

/**
 * Checks a code against the user's newest token of that type and uses it up.
 * Each wrong guess counts; after MAX_OTP_ATTEMPTS the token is deleted and a new code is needed.
 * Returns the token record (for email_change it carries pendingEmail); throws a 400 error otherwise.
 */
const consumeOTP = async (prisma, { userId, type, otp }) => {
    const record = await prisma.verificationToken.findFirst({
        where: { userId, type },
        orderBy: { createdAt: "desc" },
    });
    if (!record) throw otpError("No active code. Please request a new one.", "OTP_EXPIRED");

    if (record.expiresAt.getTime() < Date.now()) {
        await prisma.verificationToken.deleteMany({ where: { userId, type } });
        throw otpError("This code has expired. Please request a new one.", "OTP_EXPIRED");
    }

    const expected = Buffer.from(record.tokenHash, "hex");
    const given = Buffer.from(hashOTP(otp, userId), "hex");
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
        const attempts = (record.attempts ?? 0) + 1;
        if (attempts >= MAX_OTP_ATTEMPTS) {
            await prisma.verificationToken.deleteMany({ where: { userId, type } });
            throw otpError("Too many wrong codes. Please request a new one.", "OTP_LOCKED");
        }
        await prisma.verificationToken.update({ where: { id: record.id }, data: { attempts } });
        const left = MAX_OTP_ATTEMPTS - attempts;
        throw otpError(`Invalid code. ${left} attempt${left === 1 ? "" : "s"} left.`, "OTP_INVALID");
    }

    await prisma.verificationToken.deleteMany({ where: { userId, type } });
    return record;
};

module.exports = {
    // Token link (legacy)
    EMAIL_VERIFICATION_TOKEN_TTL_MS,
    createEmailVerificationToken,
    hashVerificationToken,
    buildEmailVerificationUrl,
    // OTP
    OTP_TTL_MS,
    MAX_OTP_ATTEMPTS,
    createOTP,
    hashOTP,
    consumeOTP,
};
