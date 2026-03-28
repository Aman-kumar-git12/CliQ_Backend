const recommendationActions = require("./recommendationActions");
const recommendationSections = require("./recommendationSections");
const recommendationPreferences = require("./recommendationPreferences");
const recommendationCache = require("./recommendationCache");

module.exports = {
    ...recommendationActions,
    ...recommendationSections,
    ...recommendationPreferences,
    ...recommendationCache,
};
