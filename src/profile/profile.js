const { userAuth } = require("./auth");
const express = require("express");
const ProfileRoute = express.Router();
const { ValidationFields } = require("./validation");
const { prisma } = require("../../prisma/prismaClient");

const bcrypt = require("bcrypt");

// view profile route
ProfileRoute.get("/profile", userAuth, async (req, res) => {
  try {
    const user = req.user;
    res.json({ message: "User profile fetched successfully", user });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
});

// edit profile route
ProfileRoute.put("/profile/edit", userAuth, async (req, res) => {
  try {

    const loggedInUser = req.user;

    const updateData = {};

    // updating fields
    // updating fields
    Object.keys(req.body).forEach((field) => {
      if (field !== "password") {
        if (field === "age") {
          updateData[field] = parseInt(req.body[field]);
        } else {
          updateData[field] = req.body[field];
        }
      }
    });

    // hashing password if password is being updated
    if (req.body.password) {
      const hashedPassword = await bcrypt.hash(req.body.password, 10);
      updateData.password = hashedPassword;
    }

    // console.log(updateData);

    const data = await prisma.users.update({
      where: { id: loggedInUser.id },
      data: updateData,
    });
    res.json({ message: "Profile updated successfully", user: data });
  } catch (err) {
    console.log(err)
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
});

ProfileRoute.delete("/profile/delete", userAuth, async (req, res) => {
  try {
    const loggedInUser = req.user;

    // Check if user exists
    const user = await prisma.users.findUnique({
      where: { id: loggedInUser.id },
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    // Delete user
    await prisma.users.delete({
      where: { id: loggedInUser.id },
    });

    // 🔥 Clear authentication cookie after deleting
    res.clearCookie("auth_token", {
      httpOnly: true,
      secure: true,
      sameSite: "none"
    });

    return res.json({ message: "Profile deleted successfully" });

  } catch (err) {
    console.log(err);
    return res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
});




module.exports = { ProfileRoute };
