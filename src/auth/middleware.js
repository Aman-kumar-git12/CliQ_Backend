const Validator = require('validator');
const jwt = require("jsonwebtoken");
const { prisma } = require("../../prisma/prismaClient");

const ValidationSignupData = (req) => {
    const { firstname, lastname, email, password, age } = req.body
    if (!firstname || !lastname) {
        throw new Error("Firstname and Lastname are required")
    }
    else if (!email) {
        throw new Error("Email is required")
    }
    else if (!Validator.isEmail(email)) {
        throw new Error("Invalid email format")
    }
    else if (!password) {
        throw new Error("Password is required")
    }
    else if (!Validator.isStrongPassword(password)) {
        throw new Error("Password should be strong")
    }
    else if (!age) {
        throw new Error("Age is required")
    }
    else if (age < 13) {
        throw new Error("Age must be at least 13 years")
    }

}

const userAuth = async (req, res, next) => {
    try {
        const token = req.cookies.auth_token
        if (!token) {
            throw new Error("You are Unauthorized, Please Login...")
        }

        const decodedObj = jwt.verify(token, process.env.JWT_SECRET_KEY)
        const { userId } = decodedObj

        const user = await prisma.users.findUnique({
            where: { id: userId }
        })
        if (!user) {
            throw new Error("User not found")
        }
        req.user = user
        next()
    } catch (err) {
        res.status(401).json({ message: "Authentication Error", error: err.message })
    }
}

const RequestValidation = (req, fromUserId) => {
    const { toUserId, status } = req.params;
    if (fromUserId === toUserId) {
        throw new Error("You cannot send a request to yourself");
    }
    const allowedStatus = ["interested", "ignored"];
    if (!allowedStatus.includes(status)) {
        throw new Error("Invalid status value");
    }
};

const ReviewValidation = (req) => {
    const { status } = req.params
    const allowedStatus = ['accepted', 'rejected']
    if (!allowedStatus.includes(status)) {
        throw new Error("Invalid status value")
    }
}

module.exports = {
    ValidationSignupData,
    userAuth,
    RequestValidation,
    ReviewValidation
}