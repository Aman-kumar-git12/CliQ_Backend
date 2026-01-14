const jwt = require("jsonwebtoken");
const { prisma } = require("../../prisma/prismaClient");

const userAuth = async (req, res, next) => {
    try {
        const token = req.cookies.auth_token;
        if (!token) {
            return res.status(401).json({ message: "You are Unauthorized, Please Login..." });
        }

        const decodedObj = jwt.verify(token, process.env.JWT_SECRET_KEY);
        const { userId } = decodedObj;

        const user = await prisma.users.findUnique({
            where: { id: userId }
        });

        if (!user) {
            return res.status(401).json({ message: "User not found" });
        }

        req.user = user;
        next();
    } catch (err) {
        res.status(401).json({ message: "Authentication Error", error: err.message });
    }
};

module.exports = { userAuth };
