const fs = require("fs");
const path = require("path");

const URI_FILE = path.join(__dirname, ".mongo-uri");

module.exports = async () => {
    await globalThis.__MONGO_REPLSET__?.stop();
    // Another jest run may have started since and written its own address; leave that one alone
    try {
        if (fs.readFileSync(URI_FILE, "utf8") === globalThis.__MONGO_URI__) fs.rmSync(URI_FILE, { force: true });
    } catch {
        // Already gone
    }
};
