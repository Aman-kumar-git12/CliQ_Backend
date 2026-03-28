const express = require("express");
const authRouter = express.Router();
const authController = require("../controllers/authController");
const googleAuthController = require("../controllers/googleAuthController");
const { optionalUserAuth, userAuth } = require("../middlewares/authMiddleware");
const { validateSignupData } = require("../middlewares/validationMiddleware");

authRouter.get("/auth/me", optionalUserAuth, authController.getMe);
authRouter.post("/signup", validateSignupData, authController.signup);
authRouter.post("/login", authController.login);
authRouter.get("/auth/google", googleAuthController.googleAuthStart);
authRouter.get("/auth/google/callback", googleAuthController.googleAuthCallback);
authRouter.post("/logout", authController.logout);
authRouter.post("/auth/unblock-request", authController.createUnblockRequest);

module.exports = authRouter;
