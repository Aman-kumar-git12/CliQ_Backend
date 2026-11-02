// Error monitoring with Sentry. Off unless SENTRY_DSN is set, so local runs and tests send nothing.
// Loaded first by src/app.js: Sentry has to start before Express is required to trace requests.
const Sentry = require("@sentry/node");
const { config } = require("../config");

const enabled = Boolean(config.sentry.dsn) && config.nodeEnv !== "test";

if (enabled) {
    Sentry.init({
        dsn: config.sentry.dsn,
        environment: config.nodeEnv,
        tracesSampleRate: config.sentry.tracesSampleRate,
        // Bodies hold passwords, codes and private messages; cookies hold sessions
        sendDefaultPii: false,
        maxRequestBodySize: "never",
        beforeSend(event) {
            if (event.request?.headers) {
                delete event.request.headers.cookie;
                delete event.request.headers.Cookie;
            }
            delete event.request?.cookies;
            return event;
        },
    });
}

// Sends 5xx errors to Sentry, tagged with the request id; must come after the routes, before errorHandler
const attachErrorReporting = (app) => {
    if (!enabled) return;
    app.use((err, req, res, next) => {
        if (req.id) Sentry.getCurrentScope().setTag("request_id", req.id);
        next(err);
    });
    Sentry.setupExpressErrorHandler(app);
};

const captureException = (err) => {
    if (enabled) Sentry.captureException(err);
};

module.exports = { attachErrorReporting, captureException, sentryEnabled: enabled };
