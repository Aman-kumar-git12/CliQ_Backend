const dotenv = require('dotenv');
const path = require("path");
const dotenvResult = dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});

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

// ─── CORS must be FIRST — before proxy and all other middleware ────────────────
// Without this order, the proxy forwards the upstream's `Access-Control-Allow-Origin: *`
// header back to the browser, which breaks credentialed requests (cookies).
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173")
  .split(",")
  .map(o => o.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g. curl, Postman, server-to-server)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) {
        callback(null, true);
      } else {
        console.warn(`[CORS] Rejected origin: ${origin}`);
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With", "Accept"],
  })
);
// ──────────────────────────────────────────────────────────────────────────────

app.use(cookieParser());
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ limit: "50mb", extended: true }));

app.use((req, res, next) => {
    // CSP: use dynamic port so it works whether server lands on 2003, 2004, etc.
    const backendPort = process.env.PORT || 2004;
    res.setHeader(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com https://res.cloudinary.com; connect-src 'self' http://localhost:${backendPort} http://localhost:2003 http://localhost:2004 http://localhost:8000 https://cliq-backend-1.onrender.com https://accounts.google.com https://openidconnect.googleapis.com/v1/userinfo;`
    );
    next();
});

// Proxy /api/agent → LLM service (registered AFTER CORS)
// proxyRes hook strips any wildcard CORS header the upstream sends,
// so the browser always sees the specific origin set by our CORS middleware.
app.use(
  '/api/agent',
  createProxyMiddleware({
    target: process.env.LLM_SERVICE_URL || 'http://localhost:8000',
    changeOrigin: true,
    pathRewrite: {
      '^/': '/api/',
    },
    on: {
      proxyRes: (proxyRes) => {
        delete proxyRes.headers['access-control-allow-origin'];
        delete proxyRes.headers['access-control-allow-credentials'];
      },
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

app.use("/", routes);

// Health check
app.get("/api/health", (req, res) => {
  res.status(200).send("OK");
});

// socket code
const server = http.createServer(app);
initialiseSocket(server);

app.get("/users", async (req, res) => {
  const users = await prisma.users.findMany();
  res.json(users);
});

const parsePort = (value, fallback = 2004) => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const basePort = parsePort(process.env.PORT, 2004);
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
