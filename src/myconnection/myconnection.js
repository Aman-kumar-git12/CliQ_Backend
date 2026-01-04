const express = require("express");
const myconnectionRoutes = express.Router();
const { userAuth } = require("../userConnection/auth");
const { prisma } = require("../../prisma/prismaClient");


myconnectionRoutes.get("/myconnection", userAuth, async (req, res) => {
    try {
        const myconnection = await prisma.connectionsRequest.findMany({
            where: {
                status: "accepted",
                OR: [
                    { toUserId: req.user.id },
                    { fromUserId: req.user.id }
                ]
            },
            include: {
                fromUser: true,
                toUser: true
            }
        });
        const data = myconnection.map((connection) => {
            if (connection.fromUserId.toString() === req.user.id.toString()) {
                return connection.toUser;
            }
            return connection.fromUser;
        });

        res.json(data);
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
})


module.exports = { myconnectionRoutes };