const { prisma } = require("../../prisma/prismaClient");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { safeUserSelect, toSafeUser } = require("../utils/authUtils");

const MAX_UNBLOCK_REQUESTS_PER_ACCOUNT = 5;
const UNBLOCK_REQUEST_COOLDOWN_MS = 60 * 60 * 1000;

const getMe = async (req, res) => {
    try {
        const user = await prisma.users.findUnique({
            where: { id: req.user.id },
            select: safeUserSelect,
        });

        return res.json({ user });
    } catch (err) {
        return res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const signup = async (req, res) => {
    try {
        const { firstname, lastname, email, age, password } = req.body;

        const passwordHash = await bcrypt.hash(password, 10);

        const existingUser = await prisma.users.findUnique({
            where: { email },
        });
        if (existingUser) {
            const message = existingUser.authProvider === "google"
                ? "An account with this email already exists with Google sign-in. Please continue with Google."
                : existingUser.authProvider === "hybrid"
                    ? "This email is already registered. You can continue with password or Google."
                    : "User already exists";
            return res.status(400).json({ message });
        }

        const defaultExpertise = {
            name: `${firstname} ${lastname}`,
            description: "*******",
            experience: "*******",
            skills: ["*******", "*******"],
            projects: "*******",
            achievements: "*******",
            interests: "*******",
            aboutYou: "*******",
            details: {
                email: email,
                address: "*******"
            },
            format: 1 // default template format
        };

        const user = await prisma.users.create({
            data: {
                firstname,
                lastname,
                email,
                age: isNaN(parseInt(age)) ? 18 : parseInt(age),
                password: passwordHash,
                authProvider: "local",
                role: "user",
                isBlocked: false,
                expertise: defaultExpertise,
                conversationsIds: []
            },
        });

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

        res.json({ message: "User created successfully", user: toSafeUser(user) });
    } catch (err) {
        console.error("Signup error details:", err);
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const login = async (req, res) => {
    try {
        const { email, password } = req.body;

        const user = await prisma.users.findUnique({
            where: { email },
        });
        if (!user) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

        if (user.authProvider === "google") {
            return res.status(400).json({ message: "This account uses Google sign-in. Please continue with Google." });
        }

        if (user.isBlocked) {
            return res.status(403).json({ message: "Your account has been blocked. Please contact support." });
        }

        const isValidPassword = await bcrypt.compare(password, user.password);
        if (!isValidPassword) {
            return res.status(401).json({ message: "Invalid credentials" });
        }

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

const createUnblockRequest = async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim().toLowerCase();
        const message = String(req.body?.message || "").trim();

        if (!message) {
            return res.status(400).json({ message: "Please explain why your account should be unblocked." });
        }

        if (!email) {
            return res.status(400).json({ message: "Please provide the blocked account email." });
        }

        const user = await prisma.users.findUnique({
            where: { email },
            select: { id: true, isBlocked: true },
        });

        if (!user) {
            return res.status(404).json({ message: "No account found with this email." });
        }

        if (!user.isBlocked) {
            return res.status(400).json({ message: "This account is not blocked, so an unblock request is not needed." });
        }

        const [requestCount, latestRequest] = await Promise.all([
            prisma.unblockRequest.count({
                where: { userId: user.id },
            }),
            prisma.unblockRequest.findFirst({
                where: { userId: user.id },
                orderBy: { createdAt: "desc" },
                select: { id: true, createdAt: true },
            }),
        ]);

        if (requestCount >= MAX_UNBLOCK_REQUESTS_PER_ACCOUNT) {
            return res.status(429).json({
                message: `You have reached the maximum of ${MAX_UNBLOCK_REQUESTS_PER_ACCOUNT} unblock requests for this account.`,
            });
        }

        if (latestRequest) {
            const nextAllowedTime = new Date(latestRequest.createdAt).getTime() + UNBLOCK_REQUEST_COOLDOWN_MS;
            const remainingMs = nextAllowedTime - Date.now();

            if (remainingMs > 0) {
                const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
                return res.status(429).json({
                    message: `You can send your next unblock request after ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}.`,
                });
            }
        }

        const request = await prisma.unblockRequest.create({
            data: {
                userId: user.id,
                message,
                status: "pending",
            },
        });

        return res.status(201).json({
            message: "Your unblock request has been submitted.",
            request,
        });
    } catch (err) {
        return res.status(500).json({
            message: "Internal server error",
            error: err.message
        });
    }
};

module.exports = {
    getMe,
    signup,
    login,
    logout,
    createUnblockRequest,
};
