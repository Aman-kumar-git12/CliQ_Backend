const express = require("express");
const requestRouter = express.Router();
const {
  userAuth,
  RequestValidation,
  ReviewValidation,
} = require("../userConnection/auth");
const { prisma } = require("../../prisma/prismaClient");

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

requestRouter.post(
  "/request/review/:status/:requestId",
  userAuth,
  async (req, res) => {
    try {
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
