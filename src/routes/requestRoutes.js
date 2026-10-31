const express = require("express");
const requestRouter = express.Router();
const connectionController = require("../controllers/connections/connectionController");
const recommendationFeedController = require("../controllers/recommendations/recommendationFeedController");
const recommendationActionController = require("../controllers/recommendations");
const recommendationAnalyticsController = require("../controllers/recommendations/recommendationAnalyticsController");
const recommendationPreferenceController = require("../controllers/recommendations/recommendationPreferenceController");
const { userAuth, adminAuth } = require("../middlewares/authMiddleware");
const { validateObjectIdParam, validateRequest, validateReview } = require("../middlewares/validationMiddleware");

for (const name of ["userId", "requestId", "candidateUserId", "toUserId"])
    requestRouter.param(name, validateObjectIdParam);

requestRouter.get("/user/connections/:userId", userAuth, connectionController.getConnectionStatus);
requestRouter.delete("/request/connections/delete/:requestId", userAuth, connectionController.deleteRequest);
requestRouter.get("/request/smart-users", userAuth, recommendationFeedController.getSmartUsers);

// Analytics
requestRouter.get(
    "/request/smart-users/analytics",
    userAuth,
    recommendationAnalyticsController.getRecommendationAnalytics,
);
requestRouter.get(
    "/request/smart-users/admin-analytics",
    adminAuth,
    recommendationAnalyticsController.getRecommendationAdminAnalytics,
);

// Preferences and History
requestRouter.get(
    "/request/smart-users/history",
    userAuth,
    recommendationPreferenceController.getRecommendationHistory,
);
requestRouter.get("/request/smart-users/saved", userAuth, recommendationPreferenceController.getSavedRecommendations);
requestRouter.get("/request/smart-users/interest", userAuth, recommendationPreferenceController.getInterestedUsers);
requestRouter.get(
    "/request/smart-users/not-interest",
    userAuth,
    recommendationPreferenceController.getNotInterestedUsers,
);

requestRouter.get(
    "/request/preferences/interested",
    userAuth,
    recommendationPreferenceController.getInterestedPreferences,
);
requestRouter.get(
    "/request/preferences/not-interested",
    userAuth,
    recommendationPreferenceController.getNotInterestedPreferences,
);

requestRouter.post(
    "/request/smart-users/save/:candidateUserId",
    userAuth,
    recommendationActionController.saveRecommendationCandidate,
);
requestRouter.post(
    "/request/smart-users/shown/:candidateUserId",
    userAuth,
    recommendationActionController.trackRecommendationShown,
);
requestRouter.delete(
    "/request/smart-users/save/:candidateUserId",
    userAuth,
    recommendationActionController.removeSavedRecommendation,
);

requestRouter.post(
    "/request/smart-users/interest/:candidateUserId",
    userAuth,
    recommendationActionController.toggleUserInterest,
);
requestRouter.post(
    "/request/smart-users/not-interest/:candidateUserId",
    userAuth,
    recommendationActionController.toggleUserNotInterest,
);

// "reset/:action" must be registered before ":action/:candidateUserId", which would otherwise match it
requestRouter.delete(
    "/request/smart-users/section/reset/:action",
    userAuth,
    recommendationActionController.resetRecommendationSection,
);
requestRouter.delete(
    "/request/smart-users/section/:action/:candidateUserId",
    userAuth,
    recommendationActionController.removeRecommendationSectionItem,
);
requestRouter.post("/request/send/:status/:toUserId", userAuth, validateRequest, connectionController.sendRequest);
requestRouter.post("/request/review/:status/:requestId", userAuth, validateReview, connectionController.reviewRequest);

module.exports = requestRouter;
