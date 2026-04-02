const { prisma } = require("../../../prisma/prismaClient");
const bcrypt = require("bcrypt");
const { safeUserSelect, toSafeUser } = require("../../utils/authUtils");
const { normalizeEmail, createAuthToken, setAuthCookie } = require("./authHelpers");
const { primeRecommendationFeedForUser } = require("../recommendationActionController");

const getMe = async (req, res) => {
    try {
        if (!req.user) {
            return res.json({ user: null });
        }

        if (req.user.isBlocked) {
            return res.status(403).json({ message: "Your account has been blocked. Please contact support." });
        }

        const user = await prisma.users.findUnique({
            where: { id: req.user.id },
            select: safeUserSelect,
        });

        return res.json({ user });
    } catch (err) {
        return res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const login = async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email);
        const { password } = req.body;

        const user = await prisma.users.findUnique({
            where: { email },
        });
        if (!user) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

        if (user.authProvider === "google") {
            return res.status(400).json({ message: "Use Google sign-in" });
        }

        if (user.isBlocked) {
            return res.status(403).json({ message: "Your account has been blocked. Please contact support." });
        }

        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

        if (!user.emailVerified) {
            return res.status(403).json({
                message: "Please verify your email before logging in.",
                code: "EMAIL_NOT_VERIFIED",
            });
        }

        const token = createAuthToken(user);
        setAuthCookie(res, token);
        primeRecommendationFeedForUser(user.id, user.expertise);

        return res.send({ message: "Login successful", user: toSafeUser(user) });
    } catch (err) {
        res.status(500).json({
            message: "Internal server error",
            error: err.message
        });
    }
};

const logout = (req, res) => {
    res.clearCookie("auth_token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: process.env.NODE_ENV === "production" ? "none" : "lax"
    });

    res.json({ message: "Logout successful" });
};

module.exports = { getMe, login, logout };
