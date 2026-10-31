const Validator = require("validator");
const { IMAGE_MAX_BYTES } = require("../upload/upload");

const validateSignupData = (req, res, next) => {
    try {
        const { firstname, lastname, email, password, age } = req.body;
        if (!firstname || !lastname) {
            throw new Error("Firstname and Lastname are required");
        } else if (!email) {
            throw new Error("Email is required");
        } else if (!Validator.isEmail(email)) {
            throw new Error("Invalid email format");
        } else if (!password) {
            throw new Error("Password is required");
        } else if (!Validator.isStrongPassword(password)) {
            throw new Error("Password should be strong");
        } else if (!age) {
            throw new Error("Age is required");
        } else if (age < 13) {
            throw new Error("Age must be at least 13 years");
        }
        next();
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

const validateRequest = (req, res, next) => {
    try {
        const { toUserId, status } = req.params;
        const fromUserId = req.user.id;

        if (fromUserId === toUserId) {
            throw new Error("You cannot send a request to yourself");
        }
        const allowedStatus = ["interested", "ignored"];
        if (!allowedStatus.includes(status)) {
            throw new Error("Invalid status value");
        }
        next();
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

const validateReview = (req, res, next) => {
    try {
        const { status } = req.params;
        const allowedStatus = ["accepted", "rejected"];
        if (!allowedStatus.includes(status)) {
            throw new Error("Invalid status value");
        }
        next();
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

const validatePost = (req, res, next) => {
    try {
        const content = typeof req.body.content === "string" ? req.body.content.trim() : "";
        const hasImageFile = Boolean(req.files?.image?.[0]);
        const hasVideoFile = Boolean(req.files?.video?.[0]);

        if (!content && !hasImageFile && !hasVideoFile) {
            throw new Error("Content, image, or video is required");
        }
        if (hasImageFile && req.files.image[0].size > IMAGE_MAX_BYTES) {
            throw new Error("Images must be under 10 MB");
        }
        if (content.length > 500) {
            throw new Error("Content length should be less than or equal to 500");
        }
        next();
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

const validatePostUpdate = (req, res, next) => {
    try {
        const content = typeof req.body.content === "string" ? req.body.content.trim() : "";
        if (!content) {
            throw new Error("Content is required");
        }
        if (content.length > 500) {
            throw new Error("Content length should be less than or equal to 500");
        }
        next();
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

const validateProfileEdit = (req, res, next) => {
    try {
        const allowedEditsFields = ["firstname", "lastname", "email", "age", "password", "imageUrl"];
        const isEditAllowed = Object.keys(req.body).every((field) => allowedEditsFields.includes(field));
        if (!isEditAllowed) {
            throw new Error("Invalid edit fields");
        }
        next();
    } catch (err) {
        res.status(400).json({ message: err.message });
    }
};

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

// For router.param(): a malformed MongoDB id in the URL gets a 400 instead of a Prisma error.
// "postId" is reported as "Invalid post ID format"; any user-like param ("targetuserId", "toUserId") as "Invalid user ID format".
const validateObjectIdParam = (req, res, next, value, name) => {
    if (!OBJECT_ID_REGEX.test(value)) {
        const label = /user/i.test(name) ? "user" : name.replace(/Id$/, "");
        return res.status(400).json({ message: `Invalid ${label} ID format` });
    }
    next();
};

module.exports = {
    validateObjectIdParam,
    validateSignupData,
    validateRequest,
    validateReview,
    validatePost,
    validatePostUpdate,
    validateProfileEdit,
};
