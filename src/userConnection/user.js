const express = require("express");
const { userAuth } = require("../auth/middleware");
const userRoute = express.Router();
const { prisma } = require("../../prisma/prismaClient");

userRoute.get("/user/requests", userAuth, async (req, res) => {
  try {
    const loggedInUser = req.user;
    const connectionRequests = await prisma.connectionsRequest.findMany({
      where: {
        status: "interested",
        toUserId: loggedInUser.id,
      },
    });

    res.json({ message: "Requests successfully fetched", connectionRequests });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Internal Server Error", err: err.message });
  }
});

userRoute.get("/user/connections", userAuth, async (req, res) => {
  try {
    const loggedInUser = req.user;

    const connections = await prisma.connectionsRequest.findMany({
      where: {
        status: "accepted",
        OR: [{ fromUserId: loggedInUser.id }, { toUserId: loggedInUser.id }],
      }
    });

    res.json({
      message: "Connections successfully fetched",
      connections
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Internal Server Error", err: err.message });
  }
});


// want to cancel the request 
userRoute.delete(
  "/user/connections/cancel/:toUserId",
  userAuth,
  async (req, res) => {
    try {
      const loggedInUserId = req.user.id;
      const toUserId = req.params.toUserId // convert params to number

      // You can cancel only if YOU are the sender (fromUserId)
      const connection = await prisma.connectionsRequest.findFirst({
        where: {
          fromUserId: loggedInUserId,   // YOU must be the one who sent it
          toUserId: toUserId,
          status: "interested",         // only cancel pending
        },
      });

      if (!connection) {
        return res.status(403).json({
          message:
            "You cannot cancel this request because you did not send it or it is not active.",
        });
      }

      await prisma.connectionsRequest.delete({
        where: { id: connection.id },
      });

      return res.json({
        message: "Connection request cancelled successfully.",
      });

    } catch (err) {
      return res.status(500).json({
        message: "Internal Server Error",
        error: err.message,
      });
    }
  }
);



// want to unfriend 
userRoute.delete("/user/connections/unfriend/:otherUserId", userAuth, async (req, res) => {
  try {
    const loggedInUser = req.user.id;
    const otherUserId = req.params.otherUserId;

    // Find the accepted connection (can be from either side)
    const connection = await prisma.connectionsRequest.findFirst({
      where: {
        status: "accepted",
        OR: [
          { fromUserId: loggedInUser, toUserId: otherUserId },
          { fromUserId: otherUserId, toUserId: loggedInUser }
        ]
      }
    });

    if (!connection) {
      return res.status(404).json({
        message: "No accepted connection found to remove"
      });
    }

    // Delete the accepted connection
    await prisma.connectionsRequest.delete({
      where: { id: connection.id }
    });

    res.json({
      message: "Connection removed successfully"
    });

  } catch (err) {
    res.status(500).json({
      message: "Internal Server Error",
      error: err.message
    });
  }
});




userRoute.get("/user/feed", userAuth, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 10;
    limit = limit > 50 ? 50 : limit;
    const skip = (page - 1) * limit;

    const loggedInUser = req.user;

    const connectionRequests = await prisma.connectionsRequest.findMany({
      where: {
        OR: [
          { fromUserId: loggedInUser.id },
          { toUserId: loggedInUser.id },
        ],
      },
      select: {
        fromUserId: true,
        toUserId: true,
      },
    });

    const hideUserFromFeed = new Set();
    connectionRequests.forEach((req) => {
      hideUserFromFeed.add(req.fromUserId);
      hideUserFromFeed.add(req.toUserId);
    });

    hideUserFromFeed.add(loggedInUser.id);

    const users = await prisma.users.findMany({
      where: {
        id: {
          notIn: Array.from(hideUserFromFeed),
        },
      },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        age: true,
      },
      skip: skip,
      take: limit,
    });

    res.json({ data: users });
  } catch (err) {
    res.status(400).json({ message: "Error: " + err.message });
  }
});

module.exports = { userRoute };
