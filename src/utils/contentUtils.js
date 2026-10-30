const { prisma } = require("../../prisma/prismaClient");

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;
const HASHTAG_REGEX = /#([\p{L}\p{M}\p{N}_]+)/gu;
// Not preceded by a word char, so "me@mail.com" isn't a mention.
const MENTION_REGEX = /(?<![\p{L}\p{N}_.])@([\p{L}\p{M}\p{N}_.]+)/gu;
const URL_REGEX = /\bhttps?:\/\/[^\s<>"'`]+/i;
const MAX_MENTIONS = 10;

const isObjectId = (value) => typeof value === "string" && OBJECT_ID_REGEX.test(value);

const extractHashtags = (content) =>
    [...String(content || "").matchAll(HASHTAG_REGEX)].map((m) => m[1].toLowerCase());

const extractMentionHandles = (content) => [...new Set(
    [...String(content || "").matchAll(MENTION_REGEX)]
        .map((m) => m[1].replace(/\.+$/, "").toLowerCase())
        .filter(Boolean)
)].slice(0, MAX_MENTIONS);

// Trailing punctuation is usually sentence punctuation, not part of the URL.
const extractFirstUrl = (content) => {
    const match = String(content || "").match(URL_REGEX);
    return match ? match[0].replace(/[).,!?;:'"\]]+$/, "") : null;
};

// The public handle shown across the UI: "@firstname_lastname", lowercased, no spaces.
const toHandle = (user) =>
    [user?.firstname, user?.lastname]
        .map((part) => String(part || "").replace(/\s+/g, "").toLowerCase())
        .filter(Boolean)
        .join("_");

// The same handle computed inside MongoDB, so it can be matched in a query.
const HANDLE_EXPR = {
    $toLower: {
        $replaceAll: {
            input: {
                $concat: [
                    { $ifNull: ["$firstname", ""] },
                    { $cond: [{ $gt: [{ $strLenCP: { $ifNull: ["$lastname", ""] } }, 0] }, "_", ""] },
                    { $ifNull: ["$lastname", ""] },
                ],
            },
            find: " ",
            replacement: "",
        },
    },
};

const toObjectIdString = (value) => value?.$oid ?? String(value);

/**
 * Resolves the @handles in `content` to user ids. Handles are not unique, so ids
 * the client picked from autocomplete (`hintedIds`) win; otherwise a handle only
 * resolves when exactly one active user has it.
 */
const resolveMentionIds = async (content, hintedIds = []) => {
    const handles = extractMentionHandles(content);
    if (handles.length === 0) return [];

    const rows = await prisma.users.aggregateRaw({
        pipeline: [
            { $match: { isBlocked: { $ne: true } } },
            { $addFields: { handle: HANDLE_EXPR } },
            { $match: { handle: { $in: handles } } },
            { $project: { _id: 1, handle: 1 } },
            { $limit: 200 },
        ],
    });

    const hinted = new Set((Array.isArray(hintedIds) ? hintedIds : []).filter(isObjectId));
    const byHandle = new Map();
    for (const row of rows) {
        const list = byHandle.get(row.handle) || [];
        list.push(toObjectIdString(row._id));
        byHandle.set(row.handle, list);
    }

    const ids = [];
    for (const handle of handles) {
        const candidates = byHandle.get(handle) || [];
        const picked = candidates.find((id) => hinted.has(id)) || (candidates.length === 1 ? candidates[0] : null);
        if (picked && !ids.includes(picked)) ids.push(picked);
    }
    return ids;
};

// Multipart bodies send arrays as JSON strings; JSON bodies send real arrays.
const parseIdList = (value) => {
    if (Array.isArray(value)) return value.filter(isObjectId);
    if (typeof value === "string" && value.trim()) {
        try {
            const parsed = JSON.parse(value);
            return Array.isArray(parsed) ? parsed.filter(isObjectId) : [];
        } catch {
            return value.split(",").map((v) => v.trim()).filter(isObjectId);
        }
    }
    return [];
};

module.exports = {
    OBJECT_ID_REGEX,
    HANDLE_EXPR,
    isObjectId,
    extractHashtags,
    extractMentionHandles,
    extractFirstUrl,
    toHandle,
    toObjectIdString,
    resolveMentionIds,
    parseIdList,
};
