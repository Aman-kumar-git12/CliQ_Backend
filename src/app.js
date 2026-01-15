const dotenv = require('dotenv');
const dotenvResult = dotenv.config();

const express = require("express");
const app = express();
const { prisma } = require("../prisma/prismaClient");
const routes = require("./routes/index");
const cookieParser = require("cookie-parser");
const cors = require("cors");

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


app.use("/", routes);


// socket code
const server = http.createServer(app);
initialiseSocket(server)



app.get("/users", async (req, res) => {
  const users = await prisma.users.findMany();
  res.json(users);
});



server.listen(2002, (err) => {
  console.log("Server is running on port 2003");
});

module.exports = server;
