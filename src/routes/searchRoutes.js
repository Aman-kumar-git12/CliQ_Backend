const express = require("express");
const searchRouter = express.Router();
const searchController = require("../controllers/searchController");
const { userAuth } = require("../middlewares/authMiddleware");

searchRouter.get("/user/search/suggested", userAuth, searchController.getSuggestedUsers);
searchRouter.get("/user/search/:name", userAuth, searchController.searchUserByName);
searchRouter.get("/user/:id", userAuth, searchController.getUserById);

module.exports = searchRouter;
