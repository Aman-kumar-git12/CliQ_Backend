const express = require("express");
const searchRouter = express.Router();
const searchController = require("../controllers/search/searchController");
const { userAuth } = require("../middlewares/authMiddleware");
const { validateObjectIdParam } = require("../middlewares/validationMiddleware");

for (const name of ["id"]) searchRouter.param(name, validateObjectIdParam);

searchRouter.get("/search", userAuth, searchController.globalSearch);
searchRouter.get("/search/trending-hashtags", userAuth, searchController.getTrendingHashtags);
searchRouter.get("/user/mention-suggestions", userAuth, searchController.getMentionSuggestions);
searchRouter.get("/user/search/suggested", userAuth, searchController.getSuggestedUsers);
searchRouter.get("/user/suggested", userAuth, searchController.getSuggestedUsers); // Legacy support fallback
searchRouter.get("/user/search/:name", userAuth, searchController.searchUserByName);
searchRouter.get("/user/hover-card/:id", userAuth, searchController.getHoverCardData);
searchRouter.get("/user/:id", userAuth, searchController.getUserById);

module.exports = searchRouter;
