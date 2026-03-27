const express = require("express");
const profileRouter = express.Router();
const profileController = require("../controllers/profileController");
const expertiseController = require("../controllers/expertiseController");
const { userAuth } = require("../middlewares/authMiddleware");
const { validateProfileEdit } = require("../middlewares/validationMiddleware");
const upload = require("../upload/upload");

profileRouter.get("/profile", userAuth, profileController.getProfile);
profileRouter.put("/profile/edit", userAuth, validateProfileEdit, profileController.editProfile);
profileRouter.delete("/profile/delete", userAuth, profileController.deleteProfile);
profileRouter.put("/profile/image", userAuth, upload.single("image"), profileController.updateProfileImage);

// Expertise routes
profileRouter.put("/profile/expertise", userAuth, expertiseController.updateExpertise);
profileRouter.post("/generate-ai-expertise", userAuth, expertiseController.generateAIExpertise);

module.exports = profileRouter;
