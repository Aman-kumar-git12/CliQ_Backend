// Leveled logger: every module logs through this instead of console, so LOG_LEVEL can quiet the output.
const { config } = require("../config");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

const write =
    (level, consoleMethod) =>
    (...args) => {
        if (LEVELS[level] < threshold) return;
        consoleMethod(new Date().toISOString(), level.toUpperCase().padEnd(5), ...args);
    };

module.exports = {
    debug: write("debug", console.debug),
    info: write("info", console.log),
    warn: write("warn", console.warn),
    error: write("error", console.error),
};
