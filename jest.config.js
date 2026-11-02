// Backend tests run against a throwaway in-memory MongoDB (tests/helpers/globalSetup.js), never Atlas.
module.exports = {
    testEnvironment: "node",
    roots: ["<rootDir>/tests"],
    globalSetup: "<rootDir>/tests/helpers/globalSetup.js",
    globalTeardown: "<rootDir>/tests/helpers/globalTeardown.js",
    setupFiles: ["<rootDir>/tests/helpers/env.js"],
    setupFilesAfterEnv: ["<rootDir>/tests/helpers/mocks.js"],
    // Test files share one database, so they run one at a time
    maxWorkers: 1,
    testTimeout: 30000,
    // Fire-and-forget work the app starts after a response (feed priming, AI calls) can outlive a test
    forceExit: true,
};
