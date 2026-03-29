const crypto = require("crypto");

// ── Token link (legacy, kept for backward compat) ────────────────────────────
const EMAIL_VERIFICATION_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

const createEmailVerificationToken = () => {
    const token = crypto.randomBytes(32).toString("hex");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TOKEN_TTL_MS);
    return { token, tokenHash, expiresAt };
};

const hashVerificationToken = (token) =>
    crypto.createHash("sha256").update(String(token || "")).digest("hex");

const getAllowedFrontendOrigins = () =>
    String(process.env.FRONTEND_URL || "http://localhost:5173")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

const getVerificationRedirectBaseUrl = () =>
    process.env.EMAIL_VERIFICATION_URL ||
    getAllowedFrontendOrigins()[0] ||
    "http://localhost:5173";

const buildEmailVerificationUrl = (token) => {
    const url = new URL("/verify-email", getVerificationRedirectBaseUrl());
    url.searchParams.set("token", token);
    return url.toString();
};

// ── OTP ──────────────────────────────────────────────────────────────────────
const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Generate a cryptographically random 6-digit OTP.
 * Returns { otp, otpHash, expiresAt }
 */
const createOTP = () => {
    // Generate a random number in [0, 999999] and pad to 6 digits
    const otp = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    const otpHash = crypto.createHash("sha256").update(otp).digest("hex");
    const expiresAt = new Date(Date.now() + OTP_TTL_MS);
    return { otp, otpHash, expiresAt };
};

const hashOTP = (otp) =>
    crypto.createHash("sha256").update(String(otp || "").trim()).digest("hex");

module.exports = {
    // Token link (legacy)
    EMAIL_VERIFICATION_TOKEN_TTL_MS,
    createEmailVerificationToken,
    hashVerificationToken,
    buildEmailVerificationUrl,
    // OTP
    OTP_TTL_MS,
    createOTP,
    hashOTP,
};
