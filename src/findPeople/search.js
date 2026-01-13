const express = require("express");
const { userAuth } = require("../auth/middleware");
const searchRoute = express.Router();
const { prisma } = require("../../prisma/prismaClient");
const { SearchValidation } = require("./validation");


searchRoute.get("/user/search/suggested", userAuth, async (req, res) => {
    try {
        const loggedInUserId = req.user.id;

        const connections = await prisma.connectionsRequest.findMany({
            where: {
                OR: [
                    { toUserId: loggedInUserId },
                    { fromUserId: loggedInUserId },
                ],
            },
            select: {
                fromUserId: true,
                toUserId: true,
            },
        });

        const excludedUserIds = new Set();
        connections.forEach((conn) => {
            excludedUserIds.add(conn.fromUserId);
            excludedUserIds.add(conn.toUserId);
        });
        excludedUserIds.add(loggedInUserId);

        const excludedArray = Array.from(excludedUserIds);

        const count = await prisma.users.count({
            where: {
                id: { notIn: excludedArray },
            },
        });

        const skip = count > 5 ? Math.floor(Math.random() * (count - 5 + 1)) : 0;

        const users = await prisma.users.findMany({
            where: {
                id: { notIn: excludedArray },
            },
            skip: skip,
            take: 5,
        });

        res.json(users);
    } catch (err) {
        res.status(500).json({ message: "Internal Server Error", error: err.message });
    }
});

searchRoute.get("/user/search/:name", userAuth, async (req, res) => {
    try {
        const { name } = req.params;

        const user = await prisma.users.findMany({
            where: {
                OR: [
                    { firstname: { contains: name, mode: "insensitive" } },
                    { lastname: { contains: name, mode: "insensitive" } }
                ]
            }
        });

        if (!user || user.length === 0) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json(user);

    } catch (err) {
        res.status(500).json({
            message: "Internal Server Error",
            error: err.message
        });
    }
});


searchRoute.get("/user/:id", userAuth, async (req, res) => {
    try {
        console.log("ok")
        const { id } = req.params;
        console.log(id)

        const user = await prisma.users.findUnique({
            where: { id }
        });
        console.log(user)

        if (!user) {
            return res.status(404).json({ message: "User not found" });
        }

        res.json({ user });

    } catch (err) {
        res.status(500).json({
            message: "Internal Server Error",
            error: err.message
        });
    }
});












module.exports = { searchRoute };
