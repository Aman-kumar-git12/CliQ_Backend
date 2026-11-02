const axios = require("axios");
const bcrypt = require("bcrypt");
const { prisma } = require("../../../prisma/prismaClient");
const { primeRecommendationFeedForUser } = require("../recommendations");
const { config } = require("../../config");
const logger = require("../../utils/logger");
const crypto = require("crypto");
const { startSession } = require("./authHelpers");

const GOOGLE_URLS = {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    user: "https://openidconnect.googleapis.com/v1/userinfo",
};

const getGoogleConfig = () => {
    const { clientId, clientSecret, redirectUri } = config.google;
    if (!clientId || !clientSecret || !redirectUri) {
        throw new Error("Google OAuth configuration is incomplete on the server.");
    }
    return { id: clientId, secret: clientSecret, redirect: redirectUri };
};

const getAllowedFrontendOrigins = () => config.frontendOrigins;

const getFrontendUrl = (state) => {
    const allowedOrigins = getAllowedFrontendOrigins();
    const fallbackOrigin = allowedOrigins[0] || "http://localhost:5173";

    try {
        const decoded = JSON.parse(Buffer.from(state || "", "base64url").toString("utf-8"));
        if (decoded.origin && allowedOrigins.includes(decoded.origin)) {
            return decoded.origin;
        }
    } catch {
        // A missing or tampered state just means "no origin hint": use the default frontend
    }
    return fallbackOrigin;
};

// Ties the Google callback to the browser that started the sign-in, so another site can't
// complete a sign-in into its own account in your browser (login CSRF)
const OAUTH_STATE_COOKIE = "oauth_state";
const oauthStateCookieOptions = () => ({
    httpOnly: true,
    secure: config.isProduction,
    sameSite: "lax",
    path: "/auth/google",
});

const readStateNonce = (state) => {
    try {
        return JSON.parse(Buffer.from(state || "", "base64url").toString("utf-8")).nonce || "";
    } catch {
        return "";
    }
};

const nonceMatches = (expected, given) =>
    Boolean(expected && given) &&
    expected.length === given.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(given));

const getNextAuthProvider = (provider) => {
    if (provider === "google" || provider === "hybrid") {
        return provider;
    }

    return "hybrid";
};

const googleAuthStart = (req, res) => {
    try {
        const config = getGoogleConfig();
        const allowedOrigins = getAllowedFrontendOrigins();
        let origin = null;

        try {
            origin = req.headers.referer ? new URL(req.headers.referer).origin : null;
        } catch (error) {
            origin = null;
        }

        const safeOrigin =
            origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0] || "http://localhost:5173";

        const nonce = crypto.randomBytes(16).toString("hex");
        res.cookie(OAUTH_STATE_COOKIE, nonce, { ...oauthStateCookieOptions(), maxAge: 10 * 60 * 1000 });

        const state = Buffer.from(
            JSON.stringify({
                mode: req.query.mode || "signin",
                origin: safeOrigin,
                nonce,
            }),
        ).toString("base64url");

        const url = new URL(GOOGLE_URLS.auth);
        const params = {
            client_id: config.id,
            redirect_uri: config.redirect,
            response_type: "code",
            scope: "openid email profile",
            prompt: "select_account",
            state,
        };
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
        res.redirect(url.toString());
    } catch (e) {
        res.redirect(`${getFrontendUrl()}/login?authError=${encodeURIComponent(e.message)}`);
    }
};

const googleAuthCallback = async (req, res) => {
    const state = req.query.state;
    const frontendUrl = getFrontendUrl(state);

    try {
        const expectedNonce = req.cookies?.[OAUTH_STATE_COOKIE];
        res.clearCookie(OAUTH_STATE_COOKIE, oauthStateCookieOptions());
        if (!nonceMatches(expectedNonce, readStateNonce(state))) {
            return res.redirect(
                `${frontendUrl}/login?authError=${encodeURIComponent("Sign-in expired. Please try again.")}`,
            );
        }

        const { code } = req.query;
        const config = getGoogleConfig();

        const { data: tokens } = await axios.post(
            GOOGLE_URLS.token,
            new URLSearchParams({
                code,
                client_id: config.id,
                client_secret: config.secret,
                redirect_uri: config.redirect,
                grant_type: "authorization_code",
            }),
        );

        const { data: gUser } = await axios.get(GOOGLE_URLS.user, {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        // Only a Google-verified address may sign in to (or take over) the account with that email
        if (!gUser.email || gUser.email_verified === false) {
            return res.redirect(
                `${frontendUrl}/login?authError=${encodeURIComponent("Your Google email address is not verified.")}`,
            );
        }
        const email = gUser.email.toLowerCase();
        const existingUser = await prisma.users.findUnique({
            where: { email },
        });

        if (existingUser?.isBlocked) {
            return res.redirect(
                `${frontendUrl}/blocked-account?message=${encodeURIComponent("Your account has been blocked. Please contact support.")}&email=${encodeURIComponent(email)}`,
            );
        }

        let user;

        if (!existingUser) {
            const passwordHash = await bcrypt.hash(`google-oauth:${gUser.sub}:${Date.now()}`, 10);

            user = await prisma.users.create({
                data: {
                    email,
                    firstname: gUser.given_name || "User",
                    lastname: gUser.family_name || "",
                    password: passwordHash,
                    authProvider: "google",
                    googleId: gUser.sub,
                    emailVerified: true,
                    imageUrl: gUser.picture || undefined,
                    age: 18,
                    role: "user",
                    expertise: { name: gUser.name, email },
                    conversationsIds: [],
                },
            });
        } else {
            if (existingUser.googleId && existingUser.googleId !== gUser.sub) {
                return res.redirect(
                    `${frontendUrl}/login?authError=${encodeURIComponent("This Google account does not match the linked account for this email.")}`,
                );
            }

            user = await prisma.users.update({
                where: { id: existingUser.id },
                data: {
                    googleId: existingUser.googleId || gUser.sub,
                    imageUrl: gUser.picture || existingUser.imageUrl,
                    authProvider: getNextAuthProvider(existingUser.authProvider),
                    emailVerified: true,
                },
            });
        }

        await startSession(res, user);
        primeRecommendationFeedForUser(user.id, user.expertise);
        res.redirect(`${frontendUrl}/home`);
    } catch (e) {
        logger.error("[Google Auth Callback Error]", e.message);
        res.redirect(`${frontendUrl}/login?authError=Authentication failed`);
    }
};

module.exports = { googleAuthStart, googleAuthCallback };
