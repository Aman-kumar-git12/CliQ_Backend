const jwt = require("jsonwebtoken");
const { prisma } = require("../../prisma/prismaClient");

const buildAuthError = (message, status = 401) => {
    const error = new Error(message);
    error.status = status;
    return error;
};

const getAuthenticatedUser = async (req) => {
    const token = req.cookies.auth_token;
    if (!token) {
        throw buildAuthError("You are Unauthorized, Please Login...", 401);
    }

    const decodedObj = jwt.verify(token, process.env.JWT_SECRET_KEY);
    const { userId } = decodedObj;

    const user = await prisma.users.findUnique({
        where: { id: userId }
    });

    if (!user) {
        throw buildAuthError("User not found", 401);
    }

    return user;
};

const handleAuthError = (res, err) => {
    res.status(err.status || 401).json({
        message: err.message || "Authentication Error",
        error: err.message,
    });
};

const authenticateUser = async (req, res, next) => {
    try {
        req.user = await getAuthenticatedUser(req);
        next();
    } catch (err) {
        handleAuthError(res, err);
    }
};

const requireActiveUser = (req, res, next) => {
    if (!req.user) {
        return handleAuthError(res, buildAuthError("Authentication required", 401));
    }

    if (req.user.isBlocked) {
        return handleAuthError(res, buildAuthError("Your account has been blocked. Please contact support.", 403));
    }

    return next();
};

const requireRole = (...roles) => (req, res, next) => {
    if (!req.user) {
        return handleAuthError(res, buildAuthError("Authentication required", 401));
    }

    if (!roles.includes(req.user.role)) {
        return handleAuthError(res, buildAuthError("You are not authorized to access this resource.", 403));
    }

    return next();
};

const userAuth = async (req, res, next) => {
    try {
        req.user = await getAuthenticatedUser(req);
        if (req.user.isBlocked) {
            throw buildAuthError("Your account has been blocked. Please contact support.", 403);
        }
        next();
    } catch (err) {
        handleAuthError(res, err);
    }
};

const userAuthAllowBlocked = async (req, res, next) => {
    try {
        req.user = await getAuthenticatedUser(req);
        next();
    } catch (err) {
        handleAuthError(res, err);
    }
};

const adminAuth = async (req, res, next) => {
    try {
        req.user = await getAuthenticatedUser(req);
        if (req.user.isBlocked) {
            throw buildAuthError("Your account has been blocked. Please contact support.", 403);
        }
        if (req.user.role !== "admin") {
            throw buildAuthError("You are not authorized to access this resource.", 403);
        }
        next();
    } catch (err) {
        handleAuthError(res, err);
    }
};

module.exports = {
    authenticateUser,
    requireActiveUser,
    requireRole,
    userAuth,
    userAuthAllowBlocked,
    adminAuth,
};
