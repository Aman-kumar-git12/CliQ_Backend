const { prisma } = require("../../prisma/prismaClient");

const getMyConnections = async (req, res) => {
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
};

module.exports = {
    getMyConnections
};
