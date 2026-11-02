const { prisma } = require("../../../prisma/prismaClient");
const { listUserSelect, toListUser } = require("../../utils/auth/authUtils");

// Connections are listed without emails or account fields (role, block state, login times)
const getMyConnections = async (req, res) => {
    const myconnection = await prisma.connectionsRequest.findMany({
        where: {
            status: "accepted",
            OR: [{ toUserId: req.user.id }, { fromUserId: req.user.id }],
        },
        select: {
            fromUserId: true,
            fromUser: { select: listUserSelect },
            toUser: { select: listUserSelect },
        },
    });
    const data = myconnection.map((connection) =>
        toListUser(connection.fromUserId === req.user.id ? connection.toUser : connection.fromUser),
    );

    res.json(data);
};

module.exports = {
    getMyConnections,
};
