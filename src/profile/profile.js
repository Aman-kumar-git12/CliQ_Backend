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
ProfileRoute.patch("/profile/edit", userAuth, async (req, res) => {
  try {
    if (!ValidationFields(req)) {
      throw new Error("Invalid Edits Fields");
    }

    const loggedInUser = req.user;

    const updateData = {};

    // updating fields
    Object.keys(req.body).forEach(async (field) => {
      {
        if (field !== "password") {
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
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
});


module.exports = { ProfileRoute };
