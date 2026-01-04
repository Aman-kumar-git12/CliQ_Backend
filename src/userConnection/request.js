const express = require("express");
const requestRouter = express.Router();
const {
  userAuth,
  RequestValidation,
  ReviewValidation,
} = require("../userConnection/auth");
const { prisma } = require("../../prisma/prismaClient");



// connection status between logged-in user and another user
requestRouter.get(
  "/user/connections/:userId",
  userAuth,
  async (req, res) => {
    try {
      const loggedInUserId = req.user.id; // from token
      const otherUserId = req.params.userId;

      // Find connection in either direction
      const connection = await prisma.connectionsRequest.findFirst({
        where: {
          OR: [
            { fromUserId: loggedInUserId, toUserId: otherUserId },
            { fromUserId: otherUserId, toUserId: loggedInUserId },
          ],
        },
      });

      // no connection
      if (!connection) {
        return res.json({
          status: "none",
          message: "No connection exists between these users",
        });
      }

      // connection exists
      return res.json({
        status: connection.status,
        connection,
      });

    } catch (err) {
      return res.status(500).json({
        message: "Internal Server Error",
        error: err.message,
      });
    }
  }
);


// delete request 
requestRouter.delete("/request/connections/delete/:requestId", userAuth, async (req, res) => {
  try {
    const loggedInUserId = req.user.id;
    const requestId = req.params.requestId;

    const findRequest = await prisma.connectionsRequest.findUnique({
      where: { id: requestId },
    });

    if (!findRequest || findRequest.toUserId !== loggedInUserId) {
      return res.status(404).json({ message: "Connection request not found" });
    }

    const deleted = await prisma.connectionsRequest.delete({
      where: { id: requestId },
    });

    res.json({ message: "Connection request deleted successfully", deleted });
  } catch (err) {
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
});


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
    console.log("sending Requests...");
    try {
      const fromUserId = req.user.id;
      const toUserId = req.params.toUserId;
      const status = req.params.status;

      // Basic validations
      if (!toUserId) {
        return res.status(400).json({ message: "toUserId is required" });
      }
      if (String(fromUserId) === String(toUserId)) {
        return res.status(400).json({ message: "You cannot send a request to yourself" });
      }

      // optional: validate allowed statuses
      const ALLOWED = ["interested", "accepted", "rejected", "ignored"];
      if (!ALLOWED.includes(status)) {
        return res.status(400).json({ message: `Invalid status. Allowed: ${ALLOWED.join(", ")}` });
      }

      RequestValidation(req, fromUserId);

      // ensure recipient exists
      const toUser = await prisma.users.findUnique({
        where: { id: toUserId },
      });

      if (!toUser) {
        return res.status(404).json({ message: "Recipient user not found" });
      }

      // find if any connection record exists in either direction
      const exists = await prisma.connectionsRequest.findFirst({
        where: {
          OR: [
            { fromUserId: fromUserId, toUserId: toUserId },
            { fromUserId: toUserId, toUserId: fromUserId },
          ],
        },
      });
      console.log(exists)

      if (exists) {
        // If previous request was ignored, allow resending by updating the record
        if (exists.status === "ignored") {
          const updated = await prisma.connectionsRequest.update({
            where: { id: exists.id },
            data: {
              fromUserId,
              toUserId,
              status,
              updatedAt: new Date(), // if you have timestamps
            },
          });
          console.log(updated)

          return res.json({ message: "Request sent (resend after ignored)", data: updated });
        }

        // if any other status exists, block duplicate
        return res.status(409).json({ message: "Connection already exists", existing: exists });
      }

      // create new request if no existing record
      const data = await prisma.connectionsRequest.create({
        data: {
          fromUserId,
          toUserId,
          status,
        },
      });

      console.log(data);
      return res.json({ message: "Request sent successfully", data });
    } catch (err) {
      console.log(err);
      return res.status(500).json({ message: "Internal server error", error: err.message });
    }
  }
);

// review requests 
requestRouter.post(
  "/request/review/:status/:requestId",
  userAuth,
  async (req, res) => {
    try {
      const { status, requestId } = req.params;
      const loggedInUserId = req.user.id;

      ReviewValidation(req);

      const reqId = requestId

      const findConnections = await prisma.connectionsRequest.findUnique({
        where: { id: reqId },
      });

      if (!findConnections || findConnections.toUserId !== loggedInUserId) {
        return res.status(404).json({ message: "Connection request not found" });
      }

      const data = await prisma.connectionsRequest.update({
        where: { id: reqId },
        data: { status },
      });

      res.json({ message: "Connections Reviewed Successfully", data });
    } catch (err) {
      res.status(500).json({ message: "Internal server error", error: err.message });
    }
  }
);


module.exports = { requestRouter };
