const axios = require("axios");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { prisma } = require("../../prisma/prismaClient");

const GOOGLE_URLS = {
    auth: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    user: "https://openidconnect.googleapis.com/v1/userinfo"
};

const getGoogleConfig = () => {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
        throw new Error("Google OAuth configuration is incomplete on the server.");
    }
    return { id: GOOGLE_CLIENT_ID, secret: GOOGLE_CLIENT_SECRET, redirect: GOOGLE_REDIRECT_URI };
};

const getAllowedFrontendOrigins = () =>
    String(process.env.FRONTEND_URL || "http://localhost:5173")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);

const getFrontendUrl = (state) => {
    const allowedOrigins = getAllowedFrontendOrigins();
    const fallbackOrigin = allowedOrigins[0] || "http://localhost:5173";

    try {
        const decoded = JSON.parse(Buffer.from(state || "", "base64url").toString("utf-8"));
        if (decoded.origin && allowedOrigins.includes(decoded.origin)) {
            return decoded.origin;
        }
    } catch (e) {}
    return fallbackOrigin;
};

const issueToken = (res, user) => {
    const token = jwt.sign({ userId: user.id, email: user.email }, process.env.JWT_SECRET_KEY, { expiresIn: "24h" });
    res.cookie("auth_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: 86400000 
    });
};

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

        const safeOrigin = origin && allowedOrigins.includes(origin)
            ? origin
            : (allowedOrigins[0] || "http://localhost:5173");

        const state = Buffer.from(JSON.stringify({ 
            mode: req.query.mode || "signin",
            origin: safeOrigin
        })).toString("base64url");

        const url = new URL(GOOGLE_URLS.auth);
        const params = {
            client_id: config.id, redirect_uri: config.redirect, response_type: "code",
            scope: "openid email profile", prompt: "select_account", state
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
        const { code } = req.query;
        const config = getGoogleConfig();
        
        const { data: tokens } = await axios.post(GOOGLE_URLS.token, new URLSearchParams({
            code, client_id: config.id, client_secret: config.secret, redirect_uri: config.redirect, grant_type: "authorization_code"
        }));

        const { data: gUser } = await axios.get(GOOGLE_URLS.user, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
        const email = gUser.email.toLowerCase();
        const existingUser = await prisma.users.findUnique({
            where: { email },
        });

        if (existingUser?.isBlocked) {
            return res.redirect(`${frontendUrl}/blocked-account?message=${encodeURIComponent("Your account has been blocked. Please contact support.")}&email=${encodeURIComponent(email)}`);
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
                    imageUrl: gUser.picture || undefined,
                    age: 18,
                    role: "user",
                    expertise: { name: gUser.name, email },
                    conversationsIds: [],
                },
            });
        } else {
            if (existingUser.googleId && existingUser.googleId !== gUser.sub) {
                return res.redirect(`${frontendUrl}/login?authError=${encodeURIComponent("This Google account does not match the linked account for this email.")}`);
            }

            user = await prisma.users.update({
                where: { id: existingUser.id },
                data: {
                    googleId: existingUser.googleId || gUser.sub,
                    imageUrl: gUser.picture || existingUser.imageUrl,
                    authProvider: getNextAuthProvider(existingUser.authProvider),
                },
            });
        }

        issueToken(res, user);
        res.redirect(`${frontendUrl}/home`);
    } catch (e) {
        console.error("[Google Auth Callback Error]", e.message);
        res.redirect(`${frontendUrl}/login?authError=Authentication failed`);
    }
};

module.exports = { googleAuthStart, googleAuthCallback };
