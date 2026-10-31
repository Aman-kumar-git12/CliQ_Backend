// ESLint rules for the backend: catch bugs and dead code; formatting is left to Prettier.
const js = require("@eslint/js");
const globals = require("globals");
const prettier = require("eslint-config-prettier");

module.exports = [
    { ignores: ["node_modules/", "dist/"] },
    js.configs.recommended,
    {
        files: ["**/*.js"],
        languageOptions: {
            ecmaVersion: 2023,
            sourceType: "commonjs",
            globals: { ...globals.node },
        },
        rules: {
            // "_name" marks a value that is deliberately unused, e.g. a field dropped by destructuring
            "no-unused-vars": [
                "error",
                { argsIgnorePattern: "^_|^next$", varsIgnorePattern: "^_", caughtErrors: "none" },
            ],
            // All output goes through src/utils/logger.js
            "no-console": "error",
            eqeqeq: ["error", "smart"],
            "prefer-const": ["error", { destructuring: "all" }],
            "no-var": "error",
            "no-empty": "error",
            // Settings are read only in src/config/index.js
            "no-restricted-properties": [
                "error",
                { object: "process", property: "env", message: "Use src/config instead." },
            ],
        },
    },
    {
        files: ["src/config/**/*.js", "prisma/**/*.js", "eslint.config.js"],
        rules: { "no-restricted-properties": "off" },
    },
    {
        // The logger itself, and command-line scripts that print for a person at a terminal
        files: ["src/utils/logger.js", "prisma/**/*.js"],
        rules: { "no-console": "off" },
    },
    prettier,
];
