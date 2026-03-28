const dotenv = require('dotenv');
const dotenvResult = dotenv.config();

// Global crash prevention - MUST be at the top
process.on('uncaughtException', (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
  // Keep the process alive but log the error
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[CRITICAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

const express = require("express");
const app = express();
const { prisma } = require("../prisma/prismaClient");
const routes = require("./routes/index");
const cookieParser = require("cookie-parser");
const cors = require("cors");

// socket 
const http = require("http");
const { initialiseSocket } = require("./socket/socket");
const { createProxyMiddleware } = require('http-proxy-middleware');

// Proxy /api/agent to the LLM service
app.use(
  '/api/agent',
  createProxyMiddleware({
    target: process.env.LLM_SERVICE_URL || 'http://localhost:8000',
    changeOrigin: true,
    pathRewrite: {
      '^/': '/api/',
    },
    onError: (err, req, res) => {
      console.error('[Proxy Error] AI Agent unreachable:', err.message);
      res.status(502).json({ 
        message: 'AI Agent service is temporarily unavailable',
        error: err.message
      });
    }
  })
);

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

// Add health check endpoint
app.get("/api/health", (req, res) => {
  res.status(200).send("OK");
});

// socket code
const server = http.createServer(app);
initialiseSocket(server)

app.get("/users", async (req, res) => {
  const users = await prisma.users.findMany();
  res.json(users);
});

const parsePort = (value, fallback = 2003) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const basePort = parsePort(process.env.PORT, 2003);
const maxPortRetries = parsePort(process.env.PORT_RETRY_COUNT, 10);
let activePort = basePort;

const startServer = (port) => {
  activePort = port;
  server.listen(port, () => {
    console.log(`Server is running on port ${port}`);
  });
};

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE" && activePort < basePort + maxPortRetries) {
    const nextPort = activePort + 1;
    console.warn(`Port ${activePort} is already in use. Retrying on ${nextPort}...`);
    setTimeout(() => startServer(nextPort), 150);
    return;
  }

  console.error("Failed to start server:", error);
  process.exit(1);
});

startServer(basePort);

module.exports = server;
