const express = require("express");
const profileRouter = express.Router();
const profileController = require("../controllers/profile/profileController");
const expertiseController = require("../controllers/profile/expertiseController");
const { userAuth } = require("../middlewares/authMiddleware");
const { validate } = require("../middlewares/validate");
const schemas = require("../validation/schemas");
const { imageUpload } = require("../upload/upload");

profileRouter.get("/profile", userAuth, profileController.getProfile);
profileRouter.put("/profile/edit", userAuth, validate({ body: schemas.profileEdit }), profileController.editProfile);
profileRouter.post(
    "/profile/email/change",
    userAuth,
    validate({ body: schemas.emailChangeRequest }),
    profileController.requestEmailChange,
);
profileRouter.post(
    "/profile/email/confirm",
    userAuth,
    validate({ body: schemas.emailChangeConfirm }),
    profileController.confirmEmailChange,
);
profileRouter.get("/profile/export", userAuth, profileController.exportMyData);
profileRouter.delete("/profile/delete", userAuth, profileController.deleteProfile);
profileRouter.put("/profile/image", userAuth, imageUpload.single("image"), profileController.updateProfileImage);

// Expertise routes
profileRouter.put("/profile/expertise", userAuth, expertiseController.updateExpertise);
profileRouter.post("/generate-ai-expertise", userAuth, expertiseController.generateAIExpertise);

module.exports = profileRouter;
