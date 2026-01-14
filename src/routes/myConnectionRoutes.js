const express = require("express");
const myConnectionRouter = express.Router();
const myConnectionController = require("../controllers/myConnectionController");
const { userAuth } = require("../middlewares/authMiddleware");

myConnectionRouter.get("/myconnection", userAuth, myConnectionController.getMyConnections);

module.exports = myConnectionRouter;
