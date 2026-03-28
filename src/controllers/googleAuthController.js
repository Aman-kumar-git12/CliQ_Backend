const axios = require("axios");
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

const getFrontendUrl = (state) => {
    try {
        const decoded = JSON.parse(Buffer.from(state || "", "base64url").toString("utf-8"));
        if (decoded.origin) return decoded.origin;
    } catch (e) {}
    return (process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0].trim();
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

const googleAuthStart = (req, res) => {
    try {
        const config = getGoogleConfig();
        const origin = req.headers.referer ? new URL(req.headers.referer).origin : null;
        const state = Buffer.from(JSON.stringify({ 
            mode: req.query.mode || "signin",
            origin: origin || (process.env.FRONTEND_URL || "http://localhost:5173").split(",")[0]
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

        const user = await prisma.users.upsert({
            where: { email },
            update: { googleId: gUser.sub, imageUrl: gUser.picture || undefined },
            create: {
                email, firstname: gUser.given_name || "User", lastname: gUser.family_name || "",
                password: "oauth-placeholder", authProvider: "google", googleId: gUser.sub,
                imageUrl: gUser.picture || undefined, age: 18, role: "user",
                expertise: { name: gUser.name, email }, conversationsIds: []
            }
        });

        issueToken(res, user);
        res.redirect(`${frontendUrl}/home`);
    } catch (e) {
        console.error("[Google Auth Callback Error]", e.message);
        res.redirect(`${frontendUrl}/login?authError=Authentication failed`);
    }
};

module.exports = { googleAuthStart, googleAuthCallback };
