const express = require("express");
const router = express.Router();

const authRoutes = require("./authRoutes");
const profileRoutes = require("./profileRoutes");
const requestRoutes = require("./requestRoutes");
const userRoutes = require("./userRoutes");
const postRoutes = require("./postRoutes");
const searchRoutes = require("./searchRoutes");
const myConnectionRoutes = require("./myConnectionRoutes");
const chatRoutes = require("./chatRoutes");

router.use("/", authRoutes);
router.use("/", profileRoutes);
router.use("/", requestRoutes);
router.use("/", userRoutes);
router.use("/", postRoutes);
router.use("/", searchRoutes);
router.use("/", myConnectionRoutes);
router.use("/", chatRoutes);

module.exports = router;
