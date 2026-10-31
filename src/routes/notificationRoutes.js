const express = require("express");
const notificationRouter = express.Router();
const notificationController = require("../controllers/notifications/notificationController");
const { userAuth } = require("../middlewares/authMiddleware");
const { validateObjectIdParam } = require("../middlewares/validationMiddleware");

notificationRouter.param("notificationId", validateObjectIdParam);

notificationRouter.get("/notifications", userAuth, notificationController.getNotifications);
notificationRouter.get("/notifications/unread-count", userAuth, notificationController.getUnreadNotificationCount);
// "read-all" must be registered before ":notificationId" routes
notificationRouter.patch("/notifications/read-all", userAuth, notificationController.markAllNotificationsRead);
notificationRouter.patch("/notifications/:notificationId/read", userAuth, notificationController.markNotificationRead);
notificationRouter.delete("/notifications/:notificationId", userAuth, notificationController.deleteNotification);

module.exports = notificationRouter;
