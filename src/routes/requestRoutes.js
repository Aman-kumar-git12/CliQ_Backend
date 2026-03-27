const express = require("express");
const requestRouter = express.Router();
const connectionController = require("../controllers/connectionController");
const recommendationFeedController = require("../controllers/recommendationFeedController");
const recommendationActionController = require("../controllers/recommendationActionController");
const recommendationAnalyticsController = require("../controllers/recommendationAnalyticsController");
const { userAuth } = require("../middlewares/authMiddleware");
const { validateRequest, validateReview } = require("../middlewares/validationMiddleware");

requestRouter.get("/user/connections/:userId", userAuth, connectionController.getConnectionStatus);
requestRouter.delete("/request/connections/delete/:requestId", userAuth, connectionController.deleteRequest);
requestRouter.get("/request/user", userAuth, recommendationFeedController.getRandomUser);
requestRouter.get("/request/smart-users", userAuth, recommendationFeedController.getSmartUsers);
requestRouter.get("/request/smart-users/analytics", userAuth, recommendationAnalyticsController.getRecommendationAnalytics);
requestRouter.get("/request/smart-users/admin-analytics", userAuth, recommendationAnalyticsController.getRecommendationAdminAnalytics);
requestRouter.get("/request/smart-users/history", userAuth, recommendationAnalyticsController.getRecommendationHistory);
requestRouter.get("/request/smart-users/saved", userAuth, recommendationAnalyticsController.getSavedRecommendations);
requestRouter.get("/request/smart-users/interest", userAuth, recommendationAnalyticsController.getInterestedUsers);
requestRouter.get("/request/smart-users/not-interest", userAuth, recommendationAnalyticsController.getNotInterestedUsers);

requestRouter.get("/request/preferences/interested", userAuth, recommendationAnalyticsController.getInterestedPreferences);
requestRouter.get("/request/preferences/not-interested", userAuth, recommendationAnalyticsController.getNotInterestedPreferences);

requestRouter.post("/request/smart-users/save/:candidateUserId", userAuth, recommendationActionController.saveRecommendationCandidate);
requestRouter.post("/request/smart-users/shown/:candidateUserId", userAuth, recommendationActionController.trackRecommendationShown);
requestRouter.delete("/request/smart-users/save/:candidateUserId", userAuth, recommendationActionController.removeSavedRecommendation);

requestRouter.post("/request/smart-users/interest/:candidateUserId", userAuth, recommendationActionController.toggleUserInterest);
requestRouter.post("/request/smart-users/not-interest/:candidateUserId", userAuth, recommendationActionController.toggleUserNotInterest);

requestRouter.delete("/request/smart-users/section/:action/:candidateUserId", userAuth, recommendationActionController.removeRecommendationSectionItem);
requestRouter.delete("/request/smart-users/section/reset/:action", userAuth, recommendationActionController.resetRecommendationSection);
requestRouter.post("/request/send/:status/:toUserId", userAuth, validateRequest, connectionController.sendRequest);
requestRouter.post("/request/review/:status/:requestId", userAuth, validateReview, connectionController.reviewRequest);

module.exports = requestRouter;
