const express = require("express");
const requestRouter = express.Router();
const {
  userAuth,
  RequestValidation,
  ReviewValidation,
} = require("../userConnection/auth");
const { prisma } = require("../../prisma/prismaClient");


// get random users 
requestRouter.get("/request/user", userAuth, async (req, res) => {
    try {
        const loggedInUserId = req.user.id;

        // Fetch all connections of logged-in user
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

        // Build exclusion list
        const excludedUserIds = new Set();

        connections.forEach((conn) => {
            excludedUserIds.add(conn.fromUserId);
            excludedUserIds.add(conn.toUserId);
        });

        excludedUserIds.add(loggedInUserId); // also exclude self

        const excludedArray = Array.from(excludedUserIds);

        // Count users who are NOT connected
        const count = await prisma.users.count({
            where: {
                id: { notIn: excludedArray },
            },
        });

        if (count === 0) {
            return res.status(404).json({ message: "No random user available" });
        }

        // Get a random index
        const skip = Math.floor(Math.random() * count);

        // Fetch exactly one random user
        const randomUser = await prisma.users.findMany({
            where: {
                id: { notIn: excludedArray },
            },
            skip: skip,
            take: 1,
        });

        res.json(randomUser[0]); // return the single user

    } catch (err) {
        res.status(500).json({
            message: "Internal Server Error",
            error: err.message,
        });
    }
});

// post requests
requestRouter.post(
  "/request/send/:status/:toUserId",
  userAuth,
  async (req, res) => {
    try {
      const fromUserId = req.user.id;
      const toUserId = req.params.toUserId;
      const status = req.params.status;

      RequestValidation(req, fromUserId);

      const toUser = await prisma.users.findUnique({
        where: { id: toUserId },
      });

      if (!toUser) {
        throw new Error("User not found");
      }

      const exists = await prisma.connectionsRequest.findFirst({
        where: {
          OR: [
            { fromUserId, toUserId },
            { fromUserId: toUserId, toUserId: fromUserId },
          ],
        },
      });

      if (exists) {
        throw new Error("Connections already exists");
      }

      const data = await prisma.connectionsRequest.create({
        data: {
          fromUserId,
          toUserId,
          status,
        },
      });

      res.json({ message: "Request sent successfully", data: data });
    } catch (err) {
      res
        .status(500)
        .json({ message: "Internal server error", error: err.message });
    }
  }
);

// review requests 
requestRouter.post(
  "/request/review/:status/:requestId",
  userAuth,
  async (req, res) => {
    try {
      console.log("okhh")
      const { status, requestId } = req.params;

      const loggedInUser = req.user;

      ReviewValidation(req);
      console.log(status, requestId, loggedInUser.id);

      const findConnections = await prisma.connectionsRequest.findFirst({
        where: {
          fromUserId: requestId,
          toUserId: loggedInUser._id,
          status: "interested",
        },
      });

      console.log(findConnections)
      if (!findConnections) {
        return res.status(404).json({ message: "Connections request not found" });
      }

      const updateId  = findConnections.id

      const data = await prisma.connectionsRequest.update({
        where: {
          id: updateId 
        },
        data: {
          status : status
        },
      });


      res.json({ message: "Connections Reviewed Successfully", data });
    } catch (err) {
      res
        .status(500)
        .json({ message: "Internal server error", error: err.message });
    }
  }
);

module.exports = { requestRouter };
