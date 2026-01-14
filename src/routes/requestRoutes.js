const express = require("express");
const requestRouter = express.Router();
const requestController = require("../controllers/requestController");
const { userAuth } = require("../middlewares/authMiddleware");
const { validateRequest, validateReview } = require("../middlewares/validationMiddleware");

requestRouter.get("/user/connections/:userId", userAuth, requestController.getConnectionStatus);
requestRouter.delete("/request/connections/delete/:requestId", userAuth, requestController.deleteRequest);
requestRouter.get("/request/user", userAuth, requestController.getRandomUser);
requestRouter.post("/request/send/:status/:toUserId", userAuth, validateRequest, requestController.sendRequest);
requestRouter.post("/request/review/:status/:requestId", userAuth, validateReview, requestController.reviewRequest);

module.exports = requestRouter;
