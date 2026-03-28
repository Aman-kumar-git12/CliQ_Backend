const constants = require("./constants");
const coreUtils = require("./coreUtils");
const profileSignals = require("./profileSignals");
const caching = require("./caching");
const classification = require("./classification");
const feedback = require("./feedback");
const history = require("./history");
const scoring = require("./scoring");
const ranking = require("./ranking");
const tracking = require("./tracking");
const dataFetching = require("./dataFetching");
const analytics = require("./analytics");
const matching = require("./matching");

module.exports = {
    ...constants,
    ...coreUtils,
    ...profileSignals,
    ...caching,
    ...classification,
    ...feedback,
    ...history,
    ...scoring,
    ...ranking,
    ...tracking,
    ...dataFetching,
    ...analytics,
    ...matching,
};
