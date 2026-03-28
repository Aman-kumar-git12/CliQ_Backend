const express = require("express");
const authRouter = express.Router();
const authController = require("../controllers/authController");
const googleAuthController = require("../controllers/googleAuthController");
const { userAuth } = require("../middlewares/authMiddleware");
const { validateSignupData } = require("../middlewares/validationMiddleware");

authRouter.get("/auth/me", userAuth, authController.getMe);
authRouter.post("/signup", validateSignupData, authController.signup);
authRouter.post("/login", authController.login);
authRouter.post("/auth/google", googleAuthController.googleAuth);
authRouter.post("/logout", authController.logout);
authRouter.post("/auth/unblock-request", authController.createUnblockRequest);

module.exports = authRouter;
