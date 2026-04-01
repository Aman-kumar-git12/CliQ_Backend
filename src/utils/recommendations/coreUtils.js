const { PLACEHOLDER_VALUES } = require("./constants");

const normalizeText = (value) => {
    if (value === null || value === undefined) return "";
    return String(value).trim();
};

const isMeaningfulText = (value) => {
    const normalized = normalizeText(value);
    if (!normalized) return false;
    return !PLACEHOLDER_VALUES.has(normalized.toLowerCase());
};

const normalizeTerms = (value) => {
    const rawItems = Array.isArray(value)
        ? value
        : normalizeText(value).split(/[,|\n;/]+/);

    const deduped = new Map();
    rawItems.forEach((item) => {
        const text = normalizeText(item);
        if (!isMeaningfulText(text)) return;
        const key = text.toLowerCase();
        if (!deduped.has(key)) {
            deduped.set(key, text);
        }
    });

    return Array.from(deduped.values());
};

const getNestedObject = (value) => (value && typeof value === "object" && !Array.isArray(value) ? value : {});

const getExplicitPreferenceValue = (expertise = {}, ...keys) => {
    const containers = [
        getNestedObject(expertise),
        getNestedObject(expertise.preferences),
        getNestedObject(expertise.matchPreferences),
        getNestedObject(expertise.connectionPreferences),
    ];

    for (const key of keys) {
        for (const container of containers) {
            if (container[key] !== undefined && container[key] !== null) {
                return container[key];
            }
        }
    }

    return undefined;
};

const summarizeList = (items = [], prefix = "", limit = 6) => {
    const normalized = normalizeTerms(items).slice(0, limit);
    if (normalized.length === 0) return "";
    return `${prefix}${normalized.join(", ")}`;
};

const tokenize = (values = []) => {
    const tokens = new Set();
    values.forEach((value) => {
        const text = normalizeText(value).toLowerCase();
        text
            .split(/[^a-z0-9+#.]+/i)
            .map((token) => token.trim())
            .filter((token) => token.length >= 3)
            .forEach((token) => tokens.add(token));
    });
    return tokens;
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const getRecommendationSource = (req, fallback = "smart_connections") => {
    const bodySource = normalizeText(req?.body?.source);
    const querySource = normalizeText(req?.query?.source);
    const paramSource = normalizeText(req?.params?.source);

    return bodySource || querySource || paramSource || fallback;
};

const getRecommendationMetadata = (req, extra = {}) => {
    const bodyMetadata = getNestedObject(req?.body?.metadata);
    const queryMetadata = getNestedObject(req?.query?.metadata);

    return {
        ...queryMetadata,
        ...bodyMetadata,
        ...extra,
    };
};

module.exports = {
    normalizeText,
    isMeaningfulText,
    normalizeTerms,
    getNestedObject,
    getExplicitPreferenceValue,
    summarizeList,
    tokenize,
    clamp,
    getRecommendationSource,
    getRecommendationMetadata,
};
