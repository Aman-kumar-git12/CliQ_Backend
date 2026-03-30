require('dotenv').config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { createProxyMiddleware } = require('http-proxy-middleware');

const routes = require("./routes/index");
const { initialiseSocket } = require("./socket/socket");
const redisClient = require("./config/redisClient");

// 1. Environment Validation
const requiredEnvVars = [
    'DATABASE_URL', 'JWT_SECRET_KEY', 'FRONTEND_URL',
    'CLOUD_NAME', 'CLOUD_KEY', 'CLOUD_SECRET',
    'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS'
];
const missingVars = requiredEnvVars.filter(v => !process.env[v]);
if (missingVars.length > 0) {
    console.error(`[CRITICAL] Missing required environment variables: ${missingVars.join(', ')}`);
    process.exit(1);
}

const app = express();

// 0. Shallow Health Check (Bypasses all middleware for speed & reliability)
app.get("/api/health", (req, res) => res.status(200).send("OK"));
app.get("/", (req, res) => res.status(200).json({ 
    status: "active", 
    message: "CliQ Backend is Running",
    timestamp: new Date().toISOString()
}));

const server = http.createServer(app);

// Initialize Services
redisClient.ensureReady();
initialiseSocket(server);

// 2. Global Event Handlers (Graceful Exit)
const handleExit = (signal) => {
    console.log(`[PROCESS] Received ${signal}. Closing server...`);
    server.close(() => {
        console.log('[PROCESS] Server closed. Exiting process.');
        process.exit(0);
    });
};
process.on('SIGINT', () => handleExit('SIGINT'));
process.on('SIGTERM', () => handleExit('SIGTERM'));
process.on('uncaughtException', (err) => {
    console.error('[CRITICAL] Uncaught Exception:', err);
    // In production, log error and restart
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('[CRITICAL] Unhandled Rejection:', reason);
    process.exit(1);
});

// 3. Security & Logging Middleware
app.use(helmet({
    contentSecurityPolicy: false, // Managed manually below for dynamic backendPort
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev')); // HTTP request logging

// 4. Rate Limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Limit each IP to 1000 requests per window
    message: "Too many requests from this IP, please try again later."
});
app.use("/api/", limiter); // Apply to all API routes

// 5. CORS Configuration
const allowedOrigins = (process.env.FRONTEND_URL || "http://localhost:5173").split(",").map(o => o.trim());
app.use(cors({
    origin: (origin, cb) => !origin || allowedOrigins.includes(origin) || allowedOrigins.includes("*")
        ? cb(null, true)
        : cb(new Error("Not allowed by CORS")),
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"]
}));

app.use(cookieParser());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ limit: "20mb", extended: true }));

// 6. Dynamic Content Security Policy (CSP)
app.use((req, res, next) => {
    const backendPort = process.env.PORT || 2004;
    // Build connect-src dynamically from allowedOrigins
    const originsStr = allowedOrigins.join(" ");
    const connectSrc = `connect-src 'self' ${originsStr} http://localhost:${backendPort} http://localhost:8000 https://accounts.google.com https://openidconnect.googleapis.com/v1/userinfo;`;

    // Set CSP (helmet sets defaults, we override specific ones)
    res.setHeader("Content-Security-Policy",
        `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com https://res.cloudinary.com; ${connectSrc}`
    );
    next();
});

// 7. Proxy /api/agent → LLM service
app.use('/api/agent', createProxyMiddleware({
    target: process.env.LLM_SERVICE_URL || 'http://localhost:8000',
    changeOrigin: true,
    pathRewrite: { '^/': '/api/' },
    on: {
        proxyRes: (proxyRes) => {
            delete proxyRes.headers['access-control-allow-origin'];
            delete proxyRes.headers['access-control-allow-credentials'];
        }
    },
    onError: (err, req, res) => {
        console.error('[Proxy Error] AI Agent unreachable:', err.message);
        res.status(502).json({ message: 'AI Agent service is temporarily unavailable', error: err.message });
    }
}));

// 8. Routes
app.use("/", routes);

// 9. Server Startup with Port Retry
const basePort = Number(process.env.PORT) || 2004;
const maxRetries = Number(process.env.PORT_RETRY_COUNT) || 10;
let activePort = basePort;

const startServer = (port) => {
    activePort = port;
    server.listen(port, () => console.log(`[SERVER] Started on port ${port}`));
};

server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && activePort < basePort + maxRetries) {
        console.warn(`[SERVER] Port ${activePort} in use, retrying on ${activePort + 1}...`);
        setTimeout(() => startServer(activePort + 1), 150);
    } else {
        console.error("[SERVER] Failed to start:", err);
        process.exit(1);
    }
});

startServer(basePort);
module.exports = server;
