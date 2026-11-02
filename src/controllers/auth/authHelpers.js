const { prisma } = require("../../../prisma/prismaClient");
const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const { config } = require("../../config");
const { createEmailVerificationToken, createOTP } = require("../../utils/auth/emailVerificationUtils");
const { sendVerificationEmail, sendOTPEmail } = require("../../utils/auth/mailUtils");

const MAX_UNBLOCK_REQUESTS_PER_ACCOUNT = 5;
const UNBLOCK_REQUEST_COOLDOWN_MS = 60 * 60 * 1000;
const MAX_VERIFICATION_RESENDS = 3;
const VERIFICATION_RESEND_COOLDOWN_MS = 10 * 60 * 1000;

const normalizeEmail = (email) =>
    String(email || "")
        .trim()
        .toLowerCase();

const ACCESS_COOKIE = "auth_token";
const REFRESH_COOKIE = "refresh_token";
// The refresh cookie only goes to the routes that renew or end a session
const REFRESH_COOKIE_PATH = "/auth";
// Two tabs renewing at the same moment both send the old refresh token; the second is not treated as theft
const REFRESH_REUSE_GRACE_MS = 30 * 1000;

const baseCookieOptions = () => ({
    httpOnly: true,
    secure: config.isProduction,
    // The API and the site are on different domains in production, so the browser only sends the cookie
    // with SameSite=None; requireTrustedOrigin is what stops other sites from using it.
    sameSite: config.isProduction ? "none" : "lax",
});

const sessionLengthMs = () => config.session.sessionDays * 24 * 60 * 60 * 1000;

const hashRefreshToken = (token) => crypto.createHash("sha256").update(String(token)).digest("hex");

// "tv" is the user's tokenVersion when the token was issued; bumping tokenVersion ends every older session
const createAuthToken = (user) =>
    jwt.sign({ userId: user.id, email: user.email, tv: user.tokenVersion ?? 0 }, config.jwtSecret, {
        expiresIn: config.session.accessTtlSeconds,
    });

// Both cookies live until the session ends. The access cookie outlives the token inside it, so an
// expired token still arrives and gets TOKEN_EXPIRED (the cue to renew) instead of looking signed out.
const setAuthCookie = (res, token, sessionEndsAt = new Date(Date.now() + sessionLengthMs())) => {
    res.cookie(ACCESS_COOKIE, token, { ...baseCookieOptions(), expires: sessionEndsAt });
};

// A new refresh token in the session's family; renewals keep the family and its end date
const issueRefreshToken = async (res, user, { familyId = crypto.randomUUID(), expiresAt } = {}) => {
    const token = crypto.randomBytes(48).toString("base64url");
    const record = await prisma.refreshToken.create({
        data: {
            userId: user.id,
            tokenHash: hashRefreshToken(token),
            familyId,
            tokenVersion: user.tokenVersion ?? 0,
            expiresAt: expiresAt || new Date(Date.now() + sessionLengthMs()),
        },
    });
    res.cookie(REFRESH_COOKIE, token, { ...baseCookieOptions(), path: REFRESH_COOKIE_PATH, expires: record.expiresAt });
    return record;
};

// Signs the browser in for SESSION_TTL_DAYS: a short-lived access cookie plus a refresh cookie that renews it
const startSession = async (res, user) => {
    const record = await issueRefreshToken(res, user);
    setAuthCookie(res, createAuthToken(user), record.expiresAt);
};

// Replaces `record` with a new token in the same session and sends both cookies
const renew = async (res, user, record) => {
    const next = await issueRefreshToken(res, user, { familyId: record.familyId, expiresAt: record.expiresAt });
    await prisma.refreshToken.update({
        where: { id: record.id },
        data: { revokedAt: record.revokedAt || new Date(), replacedById: next.id },
    });
    setAuthCookie(res, createAuthToken(user), record.expiresAt);
};

const clearSessionCookies = (res) => {
    res.clearCookie(ACCESS_COOKIE, baseCookieOptions());
    res.clearCookie(REFRESH_COOKIE, { ...baseCookieOptions(), path: REFRESH_COOKIE_PATH });
};

const sessionError = (message) => {
    const error = new Error(message);
    error.status = 401;
    error.code = "SESSION_ENDED";
    return error;
};

// Swaps a valid refresh token for a new one and a new access token. Returns the user.
const rotateSession = async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw sessionError("Please log in.");

    const record = await prisma.refreshToken.findUnique({
        where: { tokenHash: hashRefreshToken(token) },
        include: { user: true },
    });
    if (!record) throw sessionError("Please log in.");

    const { user } = record;
    const valid =
        record.expiresAt.getTime() > Date.now() &&
        user &&
        !user.isBlocked &&
        (user.tokenVersion ?? 0) === record.tokenVersion;
    if (!valid) {
        await prisma.refreshToken.deleteMany({ where: { familyId: record.familyId } });
        throw sessionError("Your session has ended. Please log in again.");
    }

    if (record.revokedAt) {
        // Recently replaced: a parallel renewal from another tab, which already got the new cookie
        if (Date.now() - record.revokedAt.getTime() < REFRESH_REUSE_GRACE_MS) {
            setAuthCookie(res, createAuthToken(user), record.expiresAt);
            return user;
        }
        // Its replacement was never used: the browser never received it (the server restarted or the
        // connection dropped mid-renewal), so this is the same browser, not a copy. Replace it again.
        const replacement = record.replacedById
            ? await prisma.refreshToken.findUnique({ where: { id: record.replacedById } })
            : null;
        if (replacement && !replacement.revokedAt) {
            await prisma.refreshToken.delete({ where: { id: replacement.id } });
            await renew(res, user, record);
            return user;
        }
        // An old token used after its replacement was used means it was copied: end the whole session
        await prisma.refreshToken.deleteMany({ where: { familyId: record.familyId } });
        throw sessionError("Your session has ended. Please log in again.");
    }

    await renew(res, user, record);
    return user;
};

// Signs this browser out, server side too
const endSession = async (req, res) => {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (token) {
        const record = await prisma.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(token) } });
        if (record) await prisma.refreshToken.deleteMany({ where: { familyId: record.familyId } });
    }
    clearSessionCookies(res);
};

// After a password or email change: every browser must sign in again (the caller starts a new session)
const endAllSessions = (userId) => prisma.refreshToken.deleteMany({ where: { userId } });

const sendFreshOTP = async (user) => {
    await prisma.verificationToken.deleteMany({
        where: { userId: user.id, type: "email_verification" },
    });

    const { otp, otpHash, expiresAt } = createOTP(user.id);

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
    startSession,
    rotateSession,
    endSession,
    endAllSessions,
    clearSessionCookies,
    sendFreshOTP,
    sendFreshVerificationEmail,
};
