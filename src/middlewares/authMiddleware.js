const jwt = require("jsonwebtoken");
const { prisma } = require("../../prisma/prismaClient");

const getAuthenticatedUser = async (req, { allowBlocked = false } = {}) => {
    const token = req.cookies.auth_token;
    if (!token) {
        const error = new Error("You are Unauthorized, Please Login...");
        error.status = 401;
        throw error;
    }

    const decodedObj = jwt.verify(token, process.env.JWT_SECRET_KEY);
    const { userId } = decodedObj;

    const user = await prisma.users.findUnique({
        where: { id: userId }
    });

    if (!user) {
        const error = new Error("User not found");
        error.status = 401;
        throw error;
    }

    if (user.isBlocked && !allowBlocked) {
        const error = new Error("Your account has been blocked. Please contact support.");
        error.status = 403;
        throw error;
    }

    return user;
};

const userAuth = async (req, res, next) => {
    try {
        req.user = await getAuthenticatedUser(req);
        next();
    } catch (err) {
        res.status(err.status || 401).json({ message: err.message || "Authentication Error", error: err.message });
    }
};

const userAuthAllowBlocked = async (req, res, next) => {
    try {
        req.user = await getAuthenticatedUser(req, { allowBlocked: true });
        next();
    } catch (err) {
        res.status(err.status || 401).json({ message: err.message || "Authentication Error", error: err.message });
    }
};

module.exports = { userAuth, userAuthAllowBlocked };
