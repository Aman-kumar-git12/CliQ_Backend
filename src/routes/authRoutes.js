const express = require("express");
const authRouter = express.Router();
const authController = require("../controllers/auth");
const googleAuthController = require("../controllers/auth/googleAuthController");
const { optionalUserAuth } = require("../middlewares/authMiddleware");
const { validate } = require("../middlewares/validate");
const schemas = require("../validation/schemas");

authRouter.get("/auth/me", optionalUserAuth, authController.getMe);
authRouter.post("/signup", validate({ body: schemas.signup }), authController.signup);
authRouter.post("/login", validate({ body: schemas.login }), authController.login);
authRouter.post("/auth/refresh", authController.refresh);
authRouter.get("/auth/verify-email", authController.verifyEmail); // legacy token link
authRouter.post("/auth/verify-otp", validate({ body: schemas.verifyOtp }), authController.verifyOTP); // new OTP flow

// Forgot Password
authRouter.post("/auth/forgot-password", validate({ body: schemas.emailOnly }), authController.forgotPassword);
authRouter.post("/auth/reset-password", validate({ body: schemas.resetPassword }), authController.resetPassword);

authRouter.post(
    "/auth/resend-verification",
    validate({ body: schemas.emailOnly }),
    authController.resendVerificationEmail,
);
authRouter.get("/auth/google", googleAuthController.googleAuthStart);
authRouter.get("/auth/google/callback", googleAuthController.googleAuthCallback);
authRouter.post("/logout", authController.logout);
authRouter.post("/auth/logout", authController.logout); // receives the refresh cookie, so it can end the session server side
authRouter.post(
    "/auth/unblock-request",
    validate({ body: schemas.unblockRequest }),
    authController.createUnblockRequest,
);

module.exports = authRouter;
