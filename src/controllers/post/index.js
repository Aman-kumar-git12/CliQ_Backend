const postCore = require("./postCore");
const postFeed = require("./postFeed");
const postDiscovery = require("./postDiscovery");
const postInteractions = require("./postInteractions");
const postReports = require("./postReports");

module.exports = {
    ...postCore,
    ...postFeed,
    ...postDiscovery,
    ...postInteractions,
    ...postReports,
};
