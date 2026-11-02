// Starts a single-node MongoDB replica set in memory (Prisma needs a replica set for writes)
// and hands its address to the tests through an environment variable (inherited by the test workers)
// and a file. Collections are created on first write; the schema's indexes aren't needed because the
// app checks uniqueness itself before writing.
const fs = require("fs");
const path = require("path");
const { MongoMemoryReplSet } = require("mongodb-memory-server");

const URI_FILE = path.join(__dirname, ".mongo-uri");

module.exports = async () => {
    const replSet = await MongoMemoryReplSet.create({
        replSet: { count: 1, storageEngine: "wiredTiger" },
        // The first start can be slow (binary download, or Rosetta on Apple silicon)
        instanceOpts: [{ launchTimeout: 120000 }],
    });
    const uri = replSet.getUri("cliq_test");
    globalThis.__MONGO_REPLSET__ = replSet;
    globalThis.__MONGO_URI__ = uri;
    // The variable keeps two jest runs started at the same time from reading each other's database
    process.env.CLIQ_TEST_MONGO_URI = uri;
    fs.writeFileSync(URI_FILE, uri);
};
