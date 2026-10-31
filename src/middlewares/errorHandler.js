// Last stop for every request: unknown routes get a JSON 404, and any error a route throws
// (or passes to next) becomes one JSON shape: { message }.
const { config } = require("../config");
const logger = require("../utils/logger");

const notFound = (req, res) => {
    res.status(404).json({ message: `Route not found: ${req.method} ${req.path}` });
};

// Express recognises an error handler by its four arguments, so `next` must stay in the signature
const errorHandler = (err, req, res, next) => {
    if (res.headersSent) return next(err);

    // Multer's upload limit errors carry no HTTP status of their own
    if (err.name === "MulterError") {
        const tooLarge = err.code === "LIMIT_FILE_SIZE";
        err.status = tooLarge ? 413 : 400;
        err.message = tooLarge ? "File is too large" : "Invalid upload";
    }

    const status = err.status || err.statusCode || 500;
    if (status >= 500) {
        logger.error(`${req.method} ${req.originalUrl} failed:`, err);
    } else {
        logger.warn(`${req.method} ${req.originalUrl}: ${err.message}`);
    }

    // Server errors never expose internals; client errors (bad JSON, too large) explain themselves
    const message = status >= 500 ? "Something went wrong on our side. Please try again." : err.message;
    res.status(status).json({ message, ...(config.isDevelopment && status >= 500 ? { stack: err.stack } : {}) });
};

module.exports = { notFound, errorHandler };
