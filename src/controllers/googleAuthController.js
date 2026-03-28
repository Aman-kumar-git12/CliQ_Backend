const axios = require("axios");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { prisma } = require("../../prisma/prismaClient");

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USER_INFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

const getLinkedAuthProvider = (provider) => {
    if (provider === "google" || provider === "hybrid") {
        return provider;
    }

    return "hybrid";
};

const buildDefaultExpertise = ({ firstname, lastname, email }) => ({
    name: `${firstname} ${lastname}`.trim(),
    description: "*******",
    experience: "*******",
    skills: ["*******", "*******"],
    projects: "*******",
    achievements: "*******",
    interests: "*******",
    aboutYou: "*******",
    details: {
        email,
        address: "*******",
    },
    format: 1,
});

const issueAuthCookie = (res, user) => {
    const token = jwt.sign(
        { userId: user.id, email: user.email },
        process.env.JWT_SECRET_KEY,
        { expiresIn: "24h" }
    );

    res.cookie("auth_token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
        maxAge: 24 * 60 * 60 * 1000,
    });
};

const getGoogleOAuthConfig = () => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.GOOGLE_REDIRECT_URI;

    if (!clientId || !clientSecret || !redirectUri) {
        const missing = [];
        if (!clientId) missing.push("GOOGLE_CLIENT_ID");
        if (!clientSecret) missing.push("GOOGLE_CLIENT_SECRET");
        if (!redirectUri) missing.push("GOOGLE_REDIRECT_URI");

        const error = new Error(`Google OAuth is not configured on the server. Missing: ${missing.join(", ")}`);
        error.status = 500;
        throw error;
    }

    return {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        redirectUri: redirectUri.trim(),
    };
};

const encodeState = (mode = "signin") => Buffer.from(JSON.stringify({ mode }), "utf8").toString("base64url");

const decodeState = (value) => {
    try {
        const parsed = JSON.parse(Buffer.from(String(value || ""), "base64url").toString("utf8"));
        return parsed?.mode === "signup" ? "signup" : "signin";
    } catch (error) {
        return "signin";
    }
};

const buildFrontendRedirectUrl = (path, params = {}) => {
    const baseUrl = process.env.FRONTEND_URL || "http://localhost:5173";
    const nextUrl = new URL(path, baseUrl);

    Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null && value !== "") {
            nextUrl.searchParams.set(key, String(value));
        }
    });

    return nextUrl.toString();
};

const fetchGoogleUserFromCode = async (code) => {
    const { clientId, clientSecret, redirectUri } = getGoogleOAuthConfig();

    const tokenResponse = await axios.post(
        GOOGLE_TOKEN_URL,
        new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: "authorization_code",
        }).toString(),
        {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout: 10000,
        }
    );

    const accessToken = tokenResponse.data?.access_token;
    if (!accessToken) {
        const error = new Error("Google did not return an access token.");
        error.status = 401;
        throw error;
    }

    const { data } = await axios.get(GOOGLE_USER_INFO_URL, {
        headers: {
            Authorization: `Bearer ${accessToken}`,
        },
        timeout: 10000,
    });

    if (!data.email || data.email_verified !== true) {
        const error = new Error("Google account email is not verified.");
        error.status = 401;
        throw error;
    }

    return data;
};

const findOrCreateGoogleUser = async (googleUser) => {
    const email = String(googleUser.email).trim().toLowerCase();

    let user = await prisma.users.findUnique({
        where: { email },
    });

    if (user?.isBlocked) {
        const error = new Error("Your account has been blocked. Please contact support.");
        error.status = 403;
        error.email = email;
        throw error;
    }

    if (!user) {
        const fullName = String(googleUser.name || "").trim();
        const nameParts = fullName.split(/\s+/).filter(Boolean);
        const firstname = nameParts[0] || "Google";
        const lastname = nameParts.slice(1).join(" ") || "User";
        const randomPassword = await bcrypt.hash(`google:${googleUser.sub}:${Date.now()}`, 10);

        user = await prisma.users.create({
            data: {
                firstname,
                lastname,
                email,
                age: 18,
                password: randomPassword,
                authProvider: "google",
                googleId: googleUser.sub,
                role: "user",
                isBlocked: false,
                imageUrl: googleUser.picture || undefined,
                expertise: buildDefaultExpertise({ firstname, lastname, email }),
                conversationsIds: [],
            },
        });

        return user;
    }

    if (user.googleId && user.googleId !== googleUser.sub) {
        const error = new Error("This Google account does not match the existing linked account for this email.");
        error.status = 409;
        throw error;
    }

    const nextImage = (!user.imageUrl || user.imageUrl.includes("cyber.comolho.com")) && googleUser.picture
        ? googleUser.picture
        : user.imageUrl;

    return prisma.users.update({
        where: { id: user.id },
        data: {
            authProvider: getLinkedAuthProvider(user.authProvider),
            googleId: user.googleId || googleUser.sub,
            imageUrl: nextImage,
        },
    });
};

const googleAuthStart = async (req, res) => {
    try {
        const { clientId, redirectUri } = getGoogleOAuthConfig();
        const mode = String(req.query?.mode || "signin").trim().toLowerCase() === "signup" ? "signup" : "signin";
        const authUrl = new URL(GOOGLE_AUTH_URL);

        authUrl.searchParams.set("client_id", clientId);
        authUrl.searchParams.set("redirect_uri", redirectUri);
        authUrl.searchParams.set("response_type", "code");
        authUrl.searchParams.set("scope", "openid email profile");
        authUrl.searchParams.set("access_type", "offline");
        authUrl.searchParams.set("include_granted_scopes", "true");
        authUrl.searchParams.set("prompt", "select_account");
        authUrl.searchParams.set("state", encodeState(mode));

        return res.redirect(authUrl.toString());
    } catch (error) {
        console.error("Google auth start failed:", error.message);
        return res.redirect(buildFrontendRedirectUrl("/login", {
            authError: error.message || "Google authentication failed.",
        }));
    }
};

const googleAuthCallback = async (req, res) => {
    const mode = decodeState(req.query?.state);

    try {
        const code = String(req.query?.code || "").trim();
        const googleError = String(req.query?.error || "").trim();

        if (googleError) {
            return res.redirect(buildFrontendRedirectUrl(mode === "signup" ? "/" : "/login", {
                authError: googleError.replace(/_/g, " "),
            }));
        }

        if (!code) {
            return res.redirect(buildFrontendRedirectUrl(mode === "signup" ? "/" : "/login", {
                authError: "Google login could not be completed.",
            }));
        }

        const googleUser = await fetchGoogleUserFromCode(code);
        const user = await findOrCreateGoogleUser(googleUser);

        issueAuthCookie(res, user);
        return res.redirect(buildFrontendRedirectUrl("/home"));
    } catch (error) {
        console.error("Google auth callback failed:", error.message);

        if (error.status === 403) {
            return res.redirect(buildFrontendRedirectUrl("/blocked-account", {
                email: error.email,
                message: error.message,
            }));
        }

        return res.redirect(buildFrontendRedirectUrl(mode === "signup" ? "/" : "/login", {
            authError: error.response?.data?.error_description || error.message || "Google authentication failed.",
        }));
    }
};

module.exports = {
    googleAuthStart,
    googleAuthCallback,
};
