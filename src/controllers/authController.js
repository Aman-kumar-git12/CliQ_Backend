const { prisma } = require("../../prisma/prismaClient");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const getMe = async (req, res) => {
    try {
        const user = await prisma.users.findUnique({
            where: { id: req.user.id },
            select: {
                id: true,
                firstname: true,
                lastname: true,
                email: true,
                age: true,
                createdAt: true,
                updatedAt: true,
            },
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
            return res.status(400).json({ message: "User already exists" });
        }

        const user = await prisma.users.create({
            data: {
                firstname,
                lastname,
                email,
                age: parseInt(age),
                password: passwordHash,
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

        res.json({ message: "User created successfully", user });
    } catch (err) {
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

        return res.send({ message: "Login successful", user });
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

module.exports = {
    getMe,
    signup,
    login,
    logout
};
