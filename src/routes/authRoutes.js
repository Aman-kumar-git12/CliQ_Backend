const express = require("express");
const authRouter = express.Router();
const authController = require("../controllers/auth/index");
const googleAuthController = require("../controllers/googleAuthController");
const { optionalUserAuth, userAuth } = require("../middlewares/authMiddleware");
const { validateSignupData } = require("../middlewares/validationMiddleware");

authRouter.get("/auth/me", optionalUserAuth, authController.getMe);
authRouter.post("/signup", validateSignupData, authController.signup);
authRouter.post("/login", authController.login);
authRouter.get("/auth/verify-email", authController.verifyEmail);       // legacy token link
authRouter.post("/auth/verify-otp", authController.verifyOTP);           // new OTP flow

// Forgot Password
authRouter.post("/auth/forgot-password", authController.forgotPassword);
authRouter.post("/auth/reset-password", authController.resetPassword);

authRouter.post("/auth/resend-verification", authController.resendVerificationEmail);
authRouter.get("/auth/google", googleAuthController.googleAuthStart);
authRouter.get("/auth/google/callback", googleAuthController.googleAuthCallback);
authRouter.post("/logout", authController.logout);
authRouter.post("/auth/unblock-request", authController.createUnblockRequest);

module.exports = authRouter;
