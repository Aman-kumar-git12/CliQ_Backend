const cloudinary = require("cloudinary").v2;

console.log("Cloudinary Config Debug:");
console.log("CLOUD_NAME:", process.env.CLOUD_NAME);
console.log("CLOUD_KEY:", process.env.CLOUD_KEY ? "Exists" : "Missing");
console.log("CLOUD_SECRET:", process.env.CLOUD_SECRET ? "Exists" : "Missing");

cloudinary.config({
  cloud_name: process.env.CLOUD_NAME,
  api_key: process.env.CLOUD_KEY,
  api_secret: process.env.CLOUD_SECRET,
});

module.exports = cloudinary;
