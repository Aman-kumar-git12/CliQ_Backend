const express = require("express");
const { prisma } = require("../../prisma/prismaClient");
const authUserRoutes = express.Router();
const { ValidationSignupData } = require("./validation");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// signup route
authUserRoutes.post("/signup", async (req, res) => {
  try {
    // data validation
    ValidationSignupData(req);

    const { firstname, lastname, email, age, password } = req.body;

    // encrypt password
    const passwordHash = await bcrypt.hash(password, 10);

    const existingUser = await prisma.users.findUnique({
      where: { email },
    });
    if (existingUser) {
      return res.status(400).json({ message: "User already exists" });
    }
    const user = await prisma.users.create({
      data: {
        firstname,
        lastname,
        email,
        age,
        password: passwordHash,
      },
    });
    // console.log(user);
    res.json({ message: "User created successfully", user });
  } catch (err) {
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
});


// login route
authUserRoutes.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    // check email existence
    const user = await prisma.users.findUnique({
      where: { email },
    });
    if (!user) {
      return res.json({ message: "User not found" });
    }


    // verify password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      return res.json({ message: "Invalid password" });
    }

    // generate jwt token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "24h" }
    );

    // set cookie
    res.cookie("auth_token", token, {
      expires: new Date(Date.now() + 24 * 3600000),
    });

    return res.send({ message: "Login successful", user });
  } catch (err) {
    console.log(err)
    res.status(500).json({

      message: "Internal server error",
      error: err.message,
      stack: err.stack,
    });
  }
});

authUserRoutes.post("/logout", (req, res) => {
  res.clearCookie("auth_token");
  res.json({ message: "Logout successful" });
});

module.exports = { authUserRoutes };
