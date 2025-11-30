const dotenv = require('dotenv');
const dotenvResult = dotenv.config();

const express = require("express");
const app = express();
const { prisma } = require("../prisma/prismaClient");
const { authUserRoutes } = require("./auth/auth");
const { ProfileRoute } = require("./profile/profile");
const { requestRouter } = require("./userConnection/request");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const { userRoute } = require("./userConnection/user");
const { searchRoute } = require("./findPeople/search");
const { postRoute } = require("./post/post");





app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));


app.use("/", authUserRoutes);
app.use("/", ProfileRoute);
app.use("/", requestRouter)
app.use('/', userRoute)
app.use('/', postRoute)
app.use('/', searchRoute)


// checking server


app.get("/users", async (req, res) => {
  const users = await prisma.users.findMany();
  res.json(users);
});



app.listen(2001, (err) => {
  console.log("Server is running on port 2001");
});

module.exports = app;
