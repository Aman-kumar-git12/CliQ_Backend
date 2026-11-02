// Builds the Express app: middleware, routes, API docs and error handling. It does not listen on a
// port or open sockets (src/app.js does), so tests can load it directly with supertest.
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const cookieParser = require("cookie-parser");
const swaggerUi = require("swagger-ui-express");
const { config } = require("./config");
const logger = require("./utils/logger");
const { requestId } = require("./utils/requestContext");
const { attachErrorReporting } = require("./utils/monitoring");
const { applyRateLimits, requireTrustedOrigin, isAllowedOrigin } = require("./middlewares/security");
const { notFound, errorHandler } = require("./middlewares/errorHandler");
const { buildOpenApiDocument } = require("./docs/openapi");
const { prisma } = require("../prisma/prismaClient");
const redisClient = require("./config/redisClient");
const routes = require("./routes/index");

/**
 * @param {{ addPublicRoutes?: (app: import("express").Express) => void, getPort?: () => number }} [options]
 *   addPublicRoutes: extra routes registered before the API (src/app.js adds the status page)
 */
const createApp = ({ addPublicRoutes, getPort = () => config.port } = {}) => {
    const app = express();

    // Behind Render's proxy the client address is in X-Forwarded-For; without this every visitor
    // would share the proxy's IP and one rate limit
    app.set("trust proxy", config.trustProxy);
    app.use(requestId);

    // Shallow health check: the process is up (used by the self-ping and uptime monitors)
    app.get("/api/health", (req, res) => res.status(200).send("OK"));

    // Deep health check: the database answers, and whether Redis is connected (it is optional)
    app.get("/api/health/ready", async (req, res) => {
        try {
            await prisma.$runCommandRaw({ ping: 1 });
            res.json({ status: "ok", database: "ok", redis: redisClient.isReady ? "ok" : "unavailable" });
        } catch (err) {
            logger.error("[HEALTH] Database ping failed:", err);
            res.status(503).json({ status: "error", database: "unreachable" });
        }
    });

    app.use(
        helmet({
            contentSecurityPolicy: false, // Set below, with the frontend origins in connect-src
        }),
    );
    // Each access log line carries the request id, to match it with the app's own log lines
    morgan.token("id", (req) => req.id);
    app.use(
        morgan(
            config.isProduction
                ? ':id :remote-addr ":method :url" :status :res[content-length] - :response-time ms'
                : ":method :url :status :response-time ms - :id",
            { skip: () => config.nodeEnv === "test" },
        ),
    );

    app.use(
        cors({
            origin: (origin, cb) => {
                if (!origin || isAllowedOrigin(origin)) return cb(null, true);
                logger.warn(`[CORS] Rejected origin: ${origin}`);
                return cb(null, false);
            },
            credentials: true,
            methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
            exposedHeaders: ["X-Request-Id"],
        }),
    );

    app.use(cookieParser());
    // Uploads go through multer with their own limits; JSON bodies are small
    app.use(express.json({ limit: "1mb" }));

    applyRateLimits(app);
    app.use(requireTrustedOrigin);

    app.use((req, res, next) => {
        const connectSrc = `connect-src 'self' ${config.frontendOrigins.join(" ")} http://localhost:${getPort()} http://localhost:8000 https://accounts.google.com https://openidconnect.googleapis.com/v1/userinfo;`;
        res.setHeader(
            "Content-Security-Policy",
            `default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com https://res.cloudinary.com; ${connectSrc}`,
        );
        next();
    });

    addPublicRoutes?.(app);

    // API reference generated from the routes and their validation schemas
    const openApiDocument = buildOpenApiDocument(routes);
    app.get("/api/docs/openapi.json", (req, res) => res.json(openApiDocument));
    app.use("/api/docs", swaggerUi.serve, swaggerUi.setup(openApiDocument, { customSiteTitle: "CliQ API" }));

    // The AI agent is reached only through authenticated routes (e.g. POST /aichat/stream).
    // There is deliberately no open /api/agent proxy: it let anyone spend the LLM quota and write chat history.
    app.use("/", routes);

    // JSON 404s and the central error handler must come last
    app.use(notFound);
    attachErrorReporting(app);
    app.use(errorHandler);

    return app;
};

module.exports = { createApp };
