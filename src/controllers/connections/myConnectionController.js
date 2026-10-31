const { prisma } = require("../../../prisma/prismaClient");
const { withoutSecrets } = require("../../utils/auth/authUtils");

const getMyConnections = async (req, res) => {
    const myconnection = await prisma.connectionsRequest.findMany({
        where: {
            status: "accepted",
            OR: [{ toUserId: req.user.id }, { fromUserId: req.user.id }],
        },
        include: {
            fromUser: true,
            toUser: true,
        },
    });
    const data = myconnection.map((connection) => {
        if (connection.fromUserId.toString() === req.user.id.toString()) {
            return withoutSecrets(connection.toUser);
        }
        return withoutSecrets(connection.fromUser);
    });

    res.json(data);
};

module.exports = {
    getMyConnections,
};
