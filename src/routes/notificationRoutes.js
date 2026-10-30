const express = require("express");
const notificationRouter = express.Router();
const notificationController = require("../controllers/notificationController");
const { userAuth } = require("../middlewares/authMiddleware");

notificationRouter.get("/notifications", userAuth, notificationController.getNotifications);
notificationRouter.get("/notifications/unread-count", userAuth, notificationController.getUnreadNotificationCount);
// "read-all" must be registered before ":notificationId" routes
notificationRouter.patch("/notifications/read-all", userAuth, notificationController.markAllNotificationsRead);
notificationRouter.patch("/notifications/:notificationId/read", userAuth, notificationController.markNotificationRead);
notificationRouter.delete("/notifications/:notificationId", userAuth, notificationController.deleteNotification);

module.exports = notificationRouter;
