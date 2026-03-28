const axios = require("axios");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const { prisma } = require("../../prisma/prismaClient");

const GOOGLE_TOKEN_INFO_URL = "https://oauth2.googleapis.com/tokeninfo";

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

const verifyGoogleCredential = async (credential) => {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
        const error = new Error("Google OAuth is not configured on the server.");
        error.status = 500;
        throw error;
    }

    const { data } = await axios.get(GOOGLE_TOKEN_INFO_URL, {
        params: { id_token: credential },
        timeout: 10000,
    });

    if (data.aud !== clientId) {
        const error = new Error("Google credential audience did not match this app.");
        error.status = 401;
        throw error;
    }

    if (!data.email || data.email_verified !== "true") {
        const error = new Error("Google account email is not verified.");
        error.status = 401;
        throw error;
    }

    return data;
};

const googleAuth = async (req, res) => {
    try {
        const credential = String(req.body?.credential || "").trim();
        if (!credential) {
            return res.status(400).json({ message: "Google credential is required." });
        }

        const googleUser = await verifyGoogleCredential(credential);
        const email = String(googleUser.email).trim().toLowerCase();

        let user = await prisma.users.findUnique({
            where: { email },
        });

        if (user?.isBlocked) {
            return res.status(403).json({
                message: "Your account has been blocked. Please contact support.",
                email,
            });
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
                    role: "user",
                    isBlocked: false,
                    imageUrl: googleUser.picture || undefined,
                    expertise: buildDefaultExpertise({ firstname, lastname, email }),
                    conversationsIds: [],
                },
            });
        } else if ((!user.imageUrl || user.imageUrl.includes("cyber.comolho.com")) && googleUser.picture) {
            user = await prisma.users.update({
                where: { id: user.id },
                data: { imageUrl: googleUser.picture },
            });
        }

        issueAuthCookie(res, user);
        return res.status(200).json({ message: "Google login successful", user });
    } catch (error) {
        console.error("Google auth failed:", error.message);
        return res.status(error.status || 500).json({
            message: error.response?.data?.error_description || error.message || "Google authentication failed.",
        });
    }
};

module.exports = {
    googleAuth,
};
