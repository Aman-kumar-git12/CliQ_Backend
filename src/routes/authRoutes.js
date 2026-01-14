const express = require("express");
const authRouter = express.Router();
const authController = require("../controllers/authController");
const { userAuth } = require("../middlewares/authMiddleware");
const { validateSignupData } = require("../middlewares/validationMiddleware");

authRouter.get("/auth/me", userAuth, authController.getMe);
authRouter.post("/signup", validateSignupData, authController.signup);
authRouter.post("/login", authController.login);
authRouter.post("/logout", authController.logout);

module.exports = authRouter;
