// Cloudinary client used for profile photos, post media and chat attachments.
const cloudinary = require("cloudinary").v2;
const { config } = require("../config");

cloudinary.config({
    cloud_name: config.cloudinary.cloudName,
    api_key: config.cloudinary.apiKey,
    api_secret: config.cloudinary.apiSecret,
});

// Uploads a multer file. Not upload_stream: in this SDK it leaves an internal promise that rejects with no
// handler when Cloudinary refuses a file, which crashed the whole server. upload() returns that promise instead.
const uploadBuffer = async (file, options) => {
    try {
        return await cloudinary.uploader.upload(
            `data:${file.mimetype};base64,${file.buffer.toString("base64")}`,
            options,
        );
    } catch (err) {
        // Cloudinary 4xx means the file itself was rejected (corrupt, too large); anything else is on our side
        const rejected = err.http_code >= 400 && err.http_code < 500;
        throw Object.assign(new Error(rejected ? err.message : "Upload failed"), {
            status: rejected ? 400 : 502,
            cause: err,
        });
    }
};

module.exports = cloudinary;
module.exports.uploadBuffer = uploadBuffer;
