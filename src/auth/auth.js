const express = require("express");
const { prisma } = require("../../prisma/prismaClient");
const authUserRoutes = express.Router();
const { ValidationSignupData } = require("./middleware");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

// signup route
authUserRoutes.get("/auth/me", async (req, res) => {
  try {
    const token = req.cookies.auth_token;

    if (!token) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET_KEY);

    const user = await prisma.users.findUnique({
      where: { id: decoded.userId },
      select: {
        id: true,
        firstname: true,
        lastname: true,
        email: true,
        age: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return res.json({ user });
  } catch (err) {
    return res.status(401).json({ message: "Invalid token" });
  }
});

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
        age: parseInt(age),
        password: passwordHash,
      },
    });

    // generate jwt token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "24h" }
    );

    // set cookie
    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 24 * 60 * 60 * 1000,
    });

    // console.log(user);
    res.json({ message: "User created successfully", user });
  } catch (err) {
    // console.error(err);
    res
      .status(500)
      .json({ message: "Internal server error", error: err.message });
  }
});

// login route
authUserRoutes.post("/login", async (req, res) => {
  try {
    console.log("Hii from login");
    const { email, password } = req.body;

    // check email existence
    const user = await prisma.users.findUnique({
      where: { email },
    });
    if (!user) {
      console.log("User not found");
      throw new Error("User not found");
    }

    // verify password
    const isValidPassword = await bcrypt.compare(password, user.password);
    if (!isValidPassword) {
      throw new Error("Invalid password");
    }

    // generate jwt token
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      process.env.JWT_SECRET_KEY,
      { expiresIn: "24h" }
    );

    // set cookie
    res.cookie("auth_token", token, {
      httpOnly: true,
      secure: true,
      sameSite: "none",
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.send({ message: "Login successful", user });
  } catch (err) {
    res.status(500).json({
      message: "Internal server error",
      error: err.message,
      stack: err.stack,
    });
  }
});

authUserRoutes.post("/logout", (req, res) => {
  res.clearCookie("auth_token", {
    httpOnly: true,
    secure: true,
    sameSite: "none"
  });

  res.json({ message: "Logout successful" });
});

module.exports = { authUserRoutes };
