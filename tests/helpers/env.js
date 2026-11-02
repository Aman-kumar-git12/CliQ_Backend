// Runs before each test file loads any app code. Every variable the app reads is set here, so
// nothing from a developer's .env (real database, mail, AI agent) leaks into the tests:
// dotenv never overrides a variable that is already set.
const fs = require("fs");
const path = require("path");

Object.assign(process.env, {
    NODE_ENV: "test",
    LOG_LEVEL: "error",
    LOG_FORMAT: "pretty",
    DATABASE_URL: process.env.CLIQ_TEST_MONGO_URI || fs.readFileSync(path.join(__dirname, ".mongo-uri"), "utf8"),
    JWT_SECRET_KEY: "test-jwt-secret",
    JWT_SECRET_KEY_PREVIOUS: "",
    FRONTEND_URL: "http://localhost:5173",
    EMAIL_VERIFICATION_URL: "",
    CLOUD_NAME: "test",
    CLOUD_KEY: "test",
    CLOUD_SECRET: "test",
    SMTP_USER: "test@example.com",
    SMTP_PASS: "test",
    SMTP_FROM: "test@example.com",
    AGENT_INTERNAL_KEY: "test-agent-key",
    // Nothing listens on port 9: AI features fail fast, the way they do when the agent is down
    LLM_SERVICE_URL: "http://127.0.0.1:9",
    REDIS_URL: "redis://127.0.0.1:9",
    GOOGLE_CLIENT_ID: "",
    GOOGLE_CLIENT_SECRET: "",
    GOOGLE_REDIRECT_URI: "",
    SENTRY_DSN: "",
    RATE_LIMIT_ENABLED: "false",
    TRUST_PROXY: "0",
});
