require('dotenv').config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const { createProxyMiddleware, fixRequestBody } = require('http-proxy-middleware');

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
const axios = require('axios'); // For self-pings

// 0. Server Health & Heartbeat State
const startTime = Date.now();
const heartbeats = [];
const MAX_HEARTBEATS = 10;

// Internal Heartbeat Service (Self-Ping every 12 mins to avoid Render 15m sleep limit)
const startHeartbeat = () => {
    setInterval(async () => {
        try {
            const port = process.env.PORT || 2004;
            await axios.get(`http://localhost:${port}/api/health`);
            heartbeats.unshift(new Date().toISOString());
            if (heartbeats.length > MAX_HEARTBEATS) heartbeats.pop();
            console.log(`[HEARTBEAT] Self-ping successful at ${new Date().toLocaleTimeString()}`);
        } catch (error) {
            console.error(`[HEARTBEAT] Self-ping failed: ${error.message}`);
        }
    }, 12 * 60 * 1000); // 12 minutes
};

// Start the heartbeat after a short delay
setTimeout(startHeartbeat, 5000);

// Shallow Health Check (Bypasses all middleware)
app.get("/api/health", (req, res) => res.status(200).send("OK"));

// Visual "Proof of Life" Dashboard
app.get("/", (req, res) => {
    const uptime = Math.floor((Date.now() - startTime) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;
    const uptimeStr = `${h}h ${m}m ${s}s`;

    res.status(200).send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>CliQ Backend | Status</title>
        <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0a0a0a; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
            .card { background: rgba(255,255,255,0.05); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.1); border-radius: 24px; padding: 40px; width: 90%; max-width: 450px; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
            .glow-icon { width: 80px; height: 80px; background: #00ff88; border-radius: 50%; margin: 0 auto 24px; display: flex; align-items: center; justify-content: center; box-shadow: 0 0 30px #00ff88; animation: pulse 2s infinite; }
            @keyframes pulse { 0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(0, 255, 136, 0.7); } 70% { transform: scale(1); box-shadow: 0 0 0 20px rgba(0, 255, 136, 0); } 100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(0, 255, 136, 0); } }
            h1 { font-size: 24px; margin-bottom: 8px; font-weight: 700; color: #00ff88; }
            p.status { font-size: 14px; opacity: 0.6; margin-bottom: 32px; letter-spacing: 1px; text-transform: uppercase; }
            .stat-box { background: rgba(255,255,255,0.03); border-radius: 16px; padding: 20px; margin-bottom: 24px; border: 1px solid rgba(255,255,255,0.05); }
            .stat-label { font-size: 12px; opacity: 0.5; margin-bottom: 8px; text-transform: uppercase; }
            .stat-value { font-size: 32px; font-weight: 700; font-variant-numeric: tabular-nums; }
            .heartbeat-list { text-align: left; background: rgba(0,0,0,0.2); border-radius: 12px; padding: 16px; font-size: 13px; font-family: monospace; }
            .heartbeat-title { font-size: 11px; opacity: 0.4; margin-bottom: 12px; font-family: sans-serif; text-transform: uppercase; }
            .heartbeat-item { display: flex; justify-content: space-between; margin-bottom: 6px; color: #00ff88; }
            .heartbeat-item span { opacity: 0.5; color: #fff; }
        </style>
        <script>
            setTimeout(() => location.reload(), 30000); // Auto refresh every 30s
        </script>
    </head>
    <body>
        <div class="card">
            <div class="glow-icon">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>
            </div>
            <h1>SYSTEM ACTIVE</h1>
            <p class="status">CliQ Production Backend</p>
            
            <div class="stat-box">
                <div class="stat-label">Current Uptime</div>
                <div class="stat-value">${uptimeStr}</div>
            </div>

            <div class="heartbeat-list">
                <div class="heartbeat-title">Recent Internal Heartbeats</div>
                ${heartbeats.length > 0 ? heartbeats.map(h => `<div class="heartbeat-item">SUCCESS <span>${new Date(h).toLocaleTimeString()}</span></div>`).join('') : '<div style="opacity:0.3">Waiting for first heartbeat...</div>'}
            </div>

            <p style="margin-top: 32px; font-size: 10px; opacity: 0.3;">AUTO-REFRESH EVERY 30S | SELF-PING EVERY 12M</p>
        </div>
    </body>
    </html>
    `);
});

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
        proxyReq: fixRequestBody,
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
