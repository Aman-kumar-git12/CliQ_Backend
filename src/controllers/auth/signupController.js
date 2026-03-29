const { prisma } = require("../../../prisma/prismaClient");
const bcrypt = require("bcrypt");
const { toSafeUser } = require("../../utils/authUtils");
const { normalizeEmail, sendFreshOTP } = require("./authHelpers");

const signup = async (req, res) => {
    let createdUserId = null;
    try {
        const { firstname, lastname, age, password } = req.body;
        console.log("Signup request body:", req.body);
        const email = normalizeEmail(req.body?.email);

        const passwordHash = await bcrypt.hash(password, 10);

        const existingUser = await prisma.users.findUnique({
            where: { email },
        });

        console.log("Signup attempt for email:", email, "Existing user:", !!existingUser);

        if (existingUser) {
            if (existingUser.authProvider === "local" && !existingUser.emailVerified) {
                await prisma.verificationToken.deleteMany({
                    where: { userId: existingUser.id, type: "email_verification" },
                });
                await prisma.users.delete({ where: { id: existingUser.id } });
                console.log("Cleaned up stale unverified account for:", email);
            } else {
                const message = existingUser.authProvider === "google"
                    ? "Use Google sign-in"
                    : "User already exists";
                return res.status(400).json({ message });
            }
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
            format: 1
        };

        const user = await prisma.users.create({
            data: {
                firstname,
                lastname,
                email,
                age: isNaN(parseInt(age)) ? 18 : parseInt(age),
                password: passwordHash,
                authProvider: "local",
                emailVerified: false,
                role: "user",
                isBlocked: false,
                expertise: defaultExpertise,
                conversationsIds: []
            },
        });

        createdUserId = user.id;

        await sendFreshOTP(user);

        createdUserId = null;

        res.status(201).json({
            message: "Account created! Please check your email for a 6-digit verification code.",
            email: user.email,
            user: toSafeUser(user),
        });
    } catch (err) {
        console.error("Signup error details:", err);

        if (createdUserId) {
            try {
                await prisma.verificationToken.deleteMany({
                    where: { userId: createdUserId, type: "email_verification" },
                });
                await prisma.users.delete({ where: { id: createdUserId } });
                console.log("Rolled back user creation after email failure for id:", createdUserId);
            } catch (rollbackErr) {
                console.error("Rollback failed:", rollbackErr.message);
            }
        }

        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

module.exports = { signup };
