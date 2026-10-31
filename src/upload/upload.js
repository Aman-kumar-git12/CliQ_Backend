// Multer configs per upload kind. Files are kept in memory, so every config caps size and type.
const multer = require("multer");

const MB = 1024 * 1024;
const IMAGE_MAX_BYTES = 10 * MB; // also Cloudinary's per-file limit for images and raw files
const VIDEO_MAX_BYTES = 50 * MB;
const CHAT_FILE_MAX_BYTES = 10 * MB;

const CHAT_DOCUMENT_TYPES = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "text/plain",
];

const isImage = (file) => file.mimetype.startsWith("image/");
const isVideo = (file) => file.mimetype.startsWith("video/");
// Voice messages are recorded as webm, which browsers may label audio/webm or video/webm
const isVoice = (file) => file.mimetype.startsWith("audio/") || file.mimetype === "video/webm";

const unsupportedType = () => Object.assign(new Error("This file type isn't supported"), { status: 400 });

const build = (maxBytes, isAllowed) =>
    multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: maxBytes, files: 2 },
        fileFilter: (req, file, cb) => (isAllowed(file) ? cb(null, true) : cb(unsupportedType())),
    });

const imageUpload = build(IMAGE_MAX_BYTES, isImage);

// Posts take one image and/or one video; the shared limit is the video one, so images are re-checked in validatePost
const postUpload = build(VIDEO_MAX_BYTES, (file) => (file.fieldname === "video" ? isVideo(file) : isImage(file)));

const chatUpload = build(
    CHAT_FILE_MAX_BYTES,
    (file) => isImage(file) || isVoice(file) || CHAT_DOCUMENT_TYPES.includes(file.mimetype),
);

module.exports = { imageUpload, postUpload, chatUpload, IMAGE_MAX_BYTES };
