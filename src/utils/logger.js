// Leveled logger: every module logs through this instead of console, so LOG_LEVEL can quiet the output.
// LOG_FORMAT=json (the production default) writes one JSON object per line for log search tools;
// either format includes the id of the request being handled, when there is one.
const util = require("util");
const { config } = require("../config");
const { currentContext } = require("./requestContext");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;
const json = config.logFormat === "json";

const toJsonLine = (level, args) => {
    const errors = args.filter((arg) => arg instanceof Error);
    const message = args
        .filter((arg) => !(arg instanceof Error))
        .map((arg) => (typeof arg === "string" ? arg : util.inspect(arg, { depth: 4, breakLength: Infinity })))
        .join(" ");
    const entry = { time: new Date().toISOString(), level, msg: message, ...currentContext() };
    if (errors.length) entry.err = { message: errors[0].message, name: errors[0].name, stack: errors[0].stack };
    return JSON.stringify(entry);
};

const write =
    (level, consoleMethod) =>
    (...args) => {
        if (LEVELS[level] < threshold) return;
        if (json) return consoleMethod(toJsonLine(level, args));
        const { requestId } = currentContext();
        const prefix = [new Date().toISOString(), level.toUpperCase().padEnd(5)];
        if (requestId) prefix.push(`[${requestId.slice(0, 8)}]`);
        consoleMethod(...prefix, ...args);
    };

module.exports = {
    debug: write("debug", console.debug),
    info: write("info", console.log),
    warn: write("warn", console.warn),
    error: write("error", console.error),
};
