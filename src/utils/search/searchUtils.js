const axios = require("axios");
const { prisma } = require("../../../prisma/prismaClient");
const { listUserSelect, toListUser } = require("../auth/authUtils");
const { extractHashtags, toHandle, HANDLE_EXPR, toObjectIdString } = require("../posts/contentUtils");
const { config } = require("../../config");
const logger = require("../logger");

const SEMANTIC_SEARCH_TIMEOUT_MS = config.search.semanticTimeoutMs;
const SEMANTIC_CANDIDATE_LIMIT = config.search.semanticCandidateLimit;
const SEMANTIC_CANDIDATE_TTL_MS = 60 * 1000;
const KEYWORD_CANDIDATE_LIMIT = 200;
const HASHTAG_SCAN_LIMIT = 500;
const MAX_QUERY_TOKENS = 6;

const PLACEHOLDER_VALUES = new Set(["", "****", "n/a", "na", "null", "undefined", "professional seeker"]);
// Filler words in descriptive queries ("people who know React and ML") would
// otherwise count as keyword hits; the semantic query still gets the full text.
const STOPWORDS = new Set([
    "a",
    "an",
    "and",
    "or",
    "the",
    "of",
    "in",
    "on",
    "at",
    "to",
    "for",
    "with",
    "who",
    "that",
    "is",
    "are",
    "people",
    "person",
    "someone",
    "anyone",
    "know",
    "knows",
    "knowing",
    "looking",
    "find",
    "me",
    "i",
    "want",
    "good",
    "at",
]);

// Searchable expertise fields and how strongly a hit in each one counts.
// `description` is the user's role/headline (capped at 50 chars on save).
const EXPERTISE_FIELDS = [
    { key: "skills", label: "Skills", weight: 5, exactWeight: 8 },
    { key: "description", label: "Role", weight: 4 },
    { key: "interests", label: "Interests", weight: 3 },
    { key: "experience", label: "Experience", weight: 2 },
    { key: "name", label: "Headline", weight: 2 },
    { key: "aboutYou", label: "About", weight: 1 },
    { key: "projects", label: "Projects", weight: 1 },
];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Older user documents have no isBlocked field at all. Prisma can't match
// "missing or false" on a required field (`isBlocked: false` and NOT both skip
// them), so raw queries use `$ne: true` and Prisma queries exclude blocked ids.
const getBlockedUserIds = async () =>
    (await prisma.users.findMany({ where: { isBlocked: true }, select: { id: true } })).map((u) => u.id);

// Tokens must start at a word boundary ("react" hits "React.js", not "preact").
// In profile text, short tokens such as "ml"/"ai" must also be whole words so
// they don't hit "html"/"retail"; names always prefix-match ("kun" → "Kundan").
// Lookarounds instead of \b keep "c++" and "c#" working.
const SHORT_TOKEN_LENGTH = 3;
const buildTokenPattern = (token, { prefix = false } = {}) => {
    const end = !prefix && token.length <= SHORT_TOKEN_LENGTH ? "(?=$|[^\\p{L}\\p{M}\\p{N}])" : "";
    return `(?:^|[^\\p{L}\\p{M}\\p{N}])${escapeRegex(token)}${end}`;
};
const tokenMatchers = new Map();
const matchesToken = (text, token, options = {}) => {
    const key = `${options.prefix ? "p" : "w"}:${token}`;
    if (!tokenMatchers.has(key)) tokenMatchers.set(key, new RegExp(buildTokenPattern(token, options), "iu"));
    return tokenMatchers.get(key).test(text);
};

const isMeaningful = (value) =>
    !PLACEHOLDER_VALUES.has(
        String(value ?? "")
            .trim()
            .toLowerCase(),
    );

const toTextList = (value) => {
    const items = Array.isArray(value) ? value : String(value ?? "").split(/[,|\n;]+/);
    return items.map((item) => String(item ?? "").trim()).filter((item) => item && isMeaningful(item));
};

/**
 * Normalises a raw query. A leading "#" marks a hashtag query and "@" a handle
 * query (handles are rendered as firstname_lastname in the UI).
 */
const parseQuery = (rawQuery) => {
    const query = String(rawQuery ?? "")
        .trim()
        .slice(0, 100);
    const isHashtag = query.startsWith("#");
    const text = query
        .replace(/^[#@]+/, "")
        .replace(/_/g, " ")
        .trim();
    const tokens = [
        ...new Set(
            text
                .toLowerCase()
                .split(/[\s,]+/)
                .map((t) => t.replace(/^[#@]+/, ""))
                .filter(Boolean),
        ),
    ];
    const meaningful = tokens.filter((t) => !STOPWORDS.has(t));
    // A query made only of stopwords (e.g. someone named "Who") still searches.
    const keywordTokens = (meaningful.length > 0 ? meaningful : tokens).slice(0, MAX_QUERY_TOKENS);
    return {
        query,
        text,
        tokens: keywordTokens,
        wordCount: tokens.length,
        isHashtag,
        hashtag: isHashtag ? query.slice(1).split(/\s+/)[0].toLowerCase() : "",
    };
};

// ─── People: keyword ──────────────────────────────────────────────────────────

const getExcludedUserFilter = (currentUserId) => ({
    _id: { $ne: { $oid: currentUserId } },
    isBlocked: { $ne: true },
});

const findKeywordCandidateIds = async (tokens, currentUserId) => {
    const expertisePaths = EXPERTISE_FIELDS.map((f) => `expertise.${f.key}`);
    const or = tokens.flatMap((token) => {
        const namePattern = { $regex: buildTokenPattern(token, { prefix: true }), $options: "i" };
        const textPattern = { $regex: buildTokenPattern(token), $options: "i" };
        return [
            { firstname: namePattern },
            { lastname: namePattern },
            ...expertisePaths.map((path) => ({ [path]: textPattern })),
        ];
    });

    const rows = await prisma.users.aggregateRaw({
        pipeline: [
            { $match: { ...getExcludedUserFilter(currentUserId), $or: or } },
            { $limit: KEYWORD_CANDIDATE_LIMIT },
            { $project: { _id: 1 } },
        ],
    });
    return rows.map((row) => toObjectIdString(row._id));
};

const scoreKeywordMatch = (user, tokens, fullText) => {
    let score = 0;
    const matchedOn = new Set();
    const matchedTokens = new Set();
    const first = String(user.firstname || "").toLowerCase();
    const last = String(user.lastname || "").toLowerCase();
    const fullName = `${first} ${last}`;
    const expertise = user.expertise && typeof user.expertise === "object" ? user.expertise : {};

    if (fullText && fullName.startsWith(fullText.toLowerCase())) {
        score += 12;
        matchedOn.add("Name");
    }

    for (const token of tokens) {
        const nameHit = matchesToken(fullName, token, { prefix: true });
        if (first.startsWith(token) || last.startsWith(token)) {
            score += 10;
        } else if (nameHit) {
            score += 6;
        }
        if (nameHit) {
            matchedOn.add("Name");
            matchedTokens.add(token);
        }

        for (const field of EXPERTISE_FIELDS) {
            const values = toTextList(expertise[field.key]);
            const lowered = values.map((v) => v.toLowerCase());
            const exactIndex = field.exactWeight ? lowered.indexOf(token) : -1;
            const partialIndex = lowered.findIndex((v) => matchesToken(v, token));
            if (exactIndex === -1 && partialIndex === -1) continue;

            score += exactIndex !== -1 ? field.exactWeight : field.weight;
            matchedTokens.add(token);
            matchedOn.add(
                field.key === "skills"
                    ? `Skills: ${values[exactIndex !== -1 ? exactIndex : partialIndex]}`
                    : field.label,
            );
        }
    }

    // Prefer profiles that cover every word of a multi-word query.
    if (tokens.length > 1 && matchedTokens.size === tokens.length) score += 5;

    return { score, matchedOn: [...matchedOn].slice(0, 3) };
};

// ─── People: semantic (agent embeddings) ──────────────────────────────────────

let semanticCandidateCache = { expiresAt: 0, users: [] };

const getSemanticCandidates = async () => {
    if (semanticCandidateCache.expiresAt > Date.now()) return semanticCandidateCache.users;

    const rows = await prisma.users.aggregateRaw({
        pipeline: [
            { $match: { isBlocked: { $ne: true }, expertise: { $type: "object" } } },
            { $sort: { updatedAt: -1 } },
            { $limit: SEMANTIC_CANDIDATE_LIMIT },
            { $project: { _id: 1, expertise: 1 } },
        ],
    });
    const users = rows.map((row) => ({ id: toObjectIdString(row._id), expertise: row.expertise }));
    semanticCandidateCache = { expiresAt: Date.now() + SEMANTIC_CANDIDATE_TTL_MS, users };
    return users;
};

/**
 * Asks the agent to rank profiles against the query using its cached profile
 * embeddings. Returns null when the agent is unreachable so callers can fall
 * back to keyword results only.
 */
const runSemanticPeopleSearch = async (text, currentUserId, limit) => {
    const candidates = (await getSemanticCandidates()).filter((u) => u.id !== currentUserId);
    if (candidates.length === 0) return [];

    const agentUrl = config.agent.url;
    try {
        const response = await axios.post(
            `${agentUrl}/api/match/search`,
            { query: text, candidates, topK: limit },
            { timeout: SEMANTIC_SEARCH_TIMEOUT_MS },
        );
        return Array.isArray(response.data?.results) ? response.data.results : [];
    } catch (err) {
        logger.warn(`[SEARCH] Semantic search unavailable: ${err.message}`);
        return null;
    }
};

// Semantic mode "auto" only spends an agent call on descriptive queries,
// not on someone typing a name.
const shouldUseSemantic = (mode, parsed) => {
    if (mode === "off" || parsed.isHashtag || parsed.text.length < 3) return false;
    if (mode === "on") return true;
    return parsed.wordCount >= 2;
};

const searchPeople = async (parsed, currentUserId, { limit = 20, semantic = "auto" } = {}) => {
    if (parsed.tokens.length === 0) return { people: [], semanticUsed: false, semanticAvailable: true };

    const useSemantic = shouldUseSemantic(semantic, parsed);
    const [keywordIds, semanticResults] = await Promise.all([
        findKeywordCandidateIds(parsed.tokens, currentUserId),
        useSemantic ? runSemanticPeopleSearch(parsed.text, currentUserId, limit) : Promise.resolve([]),
    ]);

    const semanticById = new Map((semanticResults || []).map((r) => [r.id, r]));
    const ids = [...new Set([...keywordIds, ...semanticById.keys()])];
    if (ids.length === 0) {
        return {
            people: [],
            semanticUsed: useSemantic && semanticResults !== null,
            semanticAvailable: semanticResults !== null,
        };
    }

    // ids come from raw queries that already exclude blocked users.
    const users = await prisma.users.findMany({
        where: { id: { in: ids } },
        select: listUserSelect,
    });

    const people = users
        .map((user) => {
            const keyword = scoreKeywordMatch(user, parsed.tokens, parsed.text);
            const semanticHit = semanticById.get(user.id);
            // Semantic similarity (~0.55–0.9) is scaled to sit alongside a strong skill hit.
            const score = keyword.score + (semanticHit ? semanticHit.score * 10 : 0);
            const matchedOn =
                keyword.matchedOn.length > 0 ? keyword.matchedOn : (semanticHit?.reasons || []).slice(0, 2);
            return {
                ...toListUser(user),
                matchedOn,
                matchType: keyword.score > 0 ? (semanticHit ? "keyword+semantic" : "keyword") : "semantic",
                score: Math.round(score * 100) / 100,
            };
        })
        .filter((person) => person.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    return {
        people,
        semanticUsed: useSemantic && semanticResults !== null,
        semanticAvailable: semanticResults !== null,
    };
};

// ─── Posts & hashtags ─────────────────────────────────────────────────────────

const searchPosts = async (parsed, { limit = 20 } = {}) => {
    if (parsed.tokens.length === 0) return [];

    const where = parsed.isHashtag
        ? { content: { contains: `#${parsed.hashtag}`, mode: "insensitive" } }
        : { AND: parsed.tokens.map((token) => ({ content: { contains: token, mode: "insensitive" } })) };

    const blockedIds = await getBlockedUserIds();
    const posts = await prisma.post.findMany({
        where: { ...where, userId: { notIn: blockedIds } },
        orderBy: { createdAt: "desc" },
        // Hashtag matches are re-checked below, so over-fetch to fill the page.
        take: parsed.isHashtag ? limit * 3 : limit,
        select: {
            id: true,
            content: true,
            image: true,
            video: true,
            createdAt: true,
            user: { select: { id: true, firstname: true, lastname: true, imageUrl: true } },
            _count: { select: { comments: true, likes: { where: { isLiked: true } } } },
        },
    });

    // `contains "#react"` also matches "#reactnative"; keep exact tags only.
    const matched = parsed.isHashtag
        ? posts.filter((post) => extractHashtags(post.content).includes(parsed.hashtag))
        : posts;

    return matched.slice(0, limit).map(({ _count, ...post }) => ({
        ...post,
        likesCount: _count.likes,
        commentsCount: _count.comments,
        hashtags: [...new Set(extractHashtags(post.content))],
    }));
};

const searchHashtags = async (parsed, { limit = 10 } = {}) => {
    const prefix = (parsed.isHashtag ? parsed.hashtag : parsed.tokens[0] || "").toLowerCase();
    if (!prefix) return [];

    const blockedIds = await getBlockedUserIds();
    const posts = await prisma.post.findMany({
        where: { content: { contains: `#${prefix}`, mode: "insensitive" }, userId: { notIn: blockedIds } },
        orderBy: { createdAt: "desc" },
        take: HASHTAG_SCAN_LIMIT,
        select: { content: true },
    });

    const counts = new Map();
    for (const post of posts) {
        // Count each tag once per post.
        for (const tag of new Set(extractHashtags(post.content))) {
            if (tag.startsWith(prefix)) counts.set(tag, (counts.get(tag) || 0) + 1);
        }
    }

    return [...counts.entries()]
        .sort((a, b) => (a[0] === prefix ? -1 : b[0] === prefix ? 1 : b[1] - a[1]))
        .slice(0, limit)
        .map(([tag, postsCount]) => ({ tag, postsCount }));
};

/**
 * @mention autocomplete: users whose public handle (firstname_lastname) or
 * first/last name starts with `prefix`.
 */
const suggestMentions = async (prefix, currentUserId, limit = 8) => {
    const q = String(prefix || "")
        .replace(/^@/, "")
        .trim()
        .toLowerCase();
    if (!q) return [];
    const pattern = { $regex: `^${escapeRegex(q)}`, $options: "i" };

    const rows = await prisma.users.aggregateRaw({
        pipeline: [
            { $match: getExcludedUserFilter(currentUserId) },
            { $addFields: { handle: HANDLE_EXPR } },
            { $match: { $or: [{ handle: pattern }, { firstname: pattern }, { lastname: pattern }] } },
            { $limit: limit },
            { $project: { _id: 1, firstname: 1, lastname: 1, imageUrl: 1 } },
        ],
    });
    return rows.map((row) => ({
        id: toObjectIdString(row._id),
        firstname: row.firstname,
        lastname: row.lastname,
        imageUrl: row.imageUrl || null,
        handle: toHandle(row),
    }));
};

module.exports = {
    suggestMentions,
    parseQuery,
    searchPeople,
    searchPosts,
    searchHashtags,
    extractHashtags,
};
