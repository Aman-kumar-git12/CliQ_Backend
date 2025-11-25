const express = require("express");
const app = express();
const { prisma } = require("../prisma/prismaClient");
const { authUserRoutes } = require("./auth/auth");
const { ProfileRoute } = require("./profile/profile");
const { requestRouter } = require("./userConnection/request");
const cookieParser = require("cookie-parser");
const cors = require("cors");
const dotenv =  require('dotenv');
const { userRoute } = require("./userConnection/user");
const { postRoute } = require("./post/post");
dotenv.config()


app.use(
  cors({
    origin: process.env.FRONTEND_URL,
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json());

app.use("/", authUserRoutes);
app.use("/", ProfileRoute);
app.use("/" ,requestRouter)
app.use('/' , userRoute)
app.use('/' , postRoute)


// checking server


app.get("/users", async (req, res) => {
  const users = await prisma.user.findMany();
  res.json(users);
});



app.listen(2000, (err) => {
  console.log("Server is running on port 2000");
});
