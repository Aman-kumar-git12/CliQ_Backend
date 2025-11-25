const express = require("express");
const { userAuth } = require("./auth");
const userRoute = express.Router();
const { prisma } = require("../../prisma/prismaClient");

userRoute.get("/user/requests", userAuth, async (req, res) => {
  try {
    const loogedInUser = req.user;
    const connectionRequests = await prisma.connectionsRequest.findMany({
      where: {
        status: "interested",
        toUserId: loogedInUser.id,
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
    const loogedInUser = req.user;

    const connections = await prisma.connectionsRequest.findMany({
      where: {
        status: "accepted",
        OR: [{ fromUserId: loogedInUser.id }, { toUserId: loogedInUser.id }],
      }
    });

    res.json({
      messaage: "Connections successfully fethed",
      connections
    });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Internal Server Error", err: err.message });
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
