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
const { myconnectionRoutes } = require("./myconnection/myconnection");
const { chatRoutes } = require("./socket/chat");

// socket 
const http = require("http");
const { initialiseSocket } = require("./socket/socket");



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
app.use('/', myconnectionRoutes)
app.use('/', chatRoutes)


// socket code
const server = http.createServer(app);
initialiseSocket(server)



app.get("/users", async (req, res) => {
  const users = await prisma.users.findMany();
  res.json(users);
});



server.listen(2003, (err) => {
  console.log("Server is running on port 2003");
});

module.exports = server;
