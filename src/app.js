// Starts the CliQ API server: the Express app (src/createApp.js), sockets, the status page and the self-ping.
const { config, missingVariables } = require("./config");
const logger = require("./utils/logger");

// 1. Environment Validation: fail before loading anything that needs these
const missingVars = missingVariables();
if (missingVars.length > 0) {
    logger.error(`[CRITICAL] Missing required environment variables: ${missingVars.join(", ")}`);
    process.exit(1);
}

// Sentry must start before Express is loaded
const { captureException } = require("./utils/monitoring");
const http = require("http");
const axios = require("axios"); // For self-pings
const { createApp } = require("./createApp");
const { initialiseSocket } = require("./socket/socket");
const redisClient = require("./config/redisClient");

// The port actually bound (it moves up when the configured one is busy)
let activePort = config.port;

// 0. Server Health & Heartbeat State
const startTime = Date.now();
const heartbeats = [];
const MAX_HEARTBEATS = 10;

// Heartbeat: Render's free tier sleeps after 15 minutes without inbound traffic. Only requests arriving from
// outside count, so a localhost ping (the default) doesn't keep it awake; KEEPALIVE_URL (the public address)
// does, at the cost of ~744 free instance hours a month.
const HEARTBEAT_INTERVAL_MS = 12 * 60 * 1000;
const startHeartbeat = () => {
    const target = config.keepaliveUrl
        ? `${config.keepaliveUrl.replace(/\/+$/, "")}/api/health`
        : `http://localhost:${activePort}/api/health`;
    setInterval(async () => {
        try {
            await axios.get(target, { timeout: 30000 });
            heartbeats.unshift(new Date().toISOString());
            if (heartbeats.length > MAX_HEARTBEATS) heartbeats.pop();
            logger.info(`[HEARTBEAT] Self-ping successful at ${new Date().toLocaleTimeString()}`);
        } catch (error) {
            logger.error(`[HEARTBEAT] Self-ping failed: ${error.message}`);
        }
    }, HEARTBEAT_INTERVAL_MS);
};

// Start the heartbeat after a short delay
setTimeout(startHeartbeat, 5000);

// Visual "Proof of Life" Dashboard
const addStatusPage = (app) =>
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
                ${heartbeats.length > 0 ? heartbeats.map((h) => `<div class="heartbeat-item">SUCCESS <span>${new Date(h).toLocaleTimeString()}</span></div>`).join("") : '<div style="opacity:0.3">Waiting for first heartbeat...</div>'}
            </div>

            <p style="margin-top: 32px; font-size: 10px; opacity: 0.3;">AUTO-REFRESH EVERY 30S | SELF-PING EVERY 12M</p>
        </div>
    </body>
    </html>
    `);
    });

const app = createApp({ addPublicRoutes: addStatusPage, getPort: () => activePort });
const server = http.createServer(app);

// Initialize Services
redisClient.ensureReady();
initialiseSocket(server);

// 2. Global Event Handlers (Graceful Exit)
const handleExit = (signal) => {
    logger.info(`[PROCESS] Received ${signal}. Closing server...`);
    server.close(() => {
        logger.info("[PROCESS] Server closed. Exiting process.");
        process.exit(0);
    });
    // Open websockets and keep-alive connections would hold close() open until the host kills the process
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 10000).unref();
};
process.on("SIGINT", () => handleExit("SIGINT"));
process.on("SIGTERM", () => handleExit("SIGTERM"));
process.on("uncaughtException", (err) => {
    logger.error("[CRITICAL] Uncaught Exception:", err);
    captureException(err);
    // Give Sentry a moment to send the report, then exit so the host restarts the process
    setTimeout(() => process.exit(1), 1000);
});
process.on("unhandledRejection", (reason) => {
    logger.error("[CRITICAL] Unhandled Rejection:", reason);
    captureException(reason);
    setTimeout(() => process.exit(1), 1000);
});

// 3. Server Startup with Port Retry
const basePort = config.port;
const maxRetries = config.portRetryCount;

const startServer = (port) => {
    activePort = port;
    server.listen(port, () => logger.info(`[SERVER] Started on port ${port}`));
};

server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && activePort < basePort + maxRetries) {
        logger.warn(`[SERVER] Port ${activePort} in use, retrying on ${activePort + 1}...`);
        setTimeout(() => startServer(activePort + 1), 150);
    } else {
        logger.error("[SERVER] Failed to start:", err);
        process.exit(1);
    }
});

startServer(basePort);
module.exports = server;
