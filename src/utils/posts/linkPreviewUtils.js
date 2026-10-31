const axios = require("axios");
const dns = require("dns");
const http = require("http");
const https = require("https");
const net = require("net");
const logger = require("../logger");

const FETCH_TIMEOUT_MS = 5000;
const MAX_HTML_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

// ─── SSRF guard ───────────────────────────────────────────────────────────────
// Previews are fetched server-side from user-supplied URLs, so every resolved
// address (including on redirect hops) must be a public one.

const isPrivateIPv4 = (ip) => {
    const [a, b] = ip.split(".").map(Number);
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        a >= 224 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19))
    );
};

const isPrivateAddress = (ip) => {
    if (net.isIPv4(ip)) return isPrivateIPv4(ip);
    const lower = ip.toLowerCase();
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIPv4(mapped[1]);
    return (
        lower === "::" ||
        lower === "::1" ||
        lower.startsWith("fc") ||
        lower.startsWith("fd") ||
        lower.startsWith("fe8") ||
        lower.startsWith("fe9") ||
        lower.startsWith("fea") ||
        lower.startsWith("feb") ||
        lower.startsWith("ff")
    );
};

const safeLookup = (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
        if (err) return callback(err);
        const blocked = addresses.find((a) => isPrivateAddress(a.address));
        if (blocked || addresses.length === 0) {
            return callback(new Error(`Refusing to fetch private address for ${hostname}`));
        }
        if (options.all) return callback(null, addresses);
        return callback(null, addresses[0].address, addresses[0].family);
    });
};

// Node skips `lookup` for IP-literal hosts, so those are checked directly.
const isBlockedHost = (hostname) => {
    const host = String(hostname || "").replace(/^\[|\]$/g, "");
    if (!host || host.toLowerCase() === "localhost" || host.toLowerCase().endsWith(".localhost")) return true;
    return net.isIP(host) !== 0 && isPrivateAddress(host);
};

const httpAgent = new http.Agent({ lookup: safeLookup });
const httpsAgent = new https.Agent({ lookup: safeLookup });

const normalizeUrl = (raw) => {
    try {
        const url = new URL(String(raw || "").trim());
        if (!["http:", "https:"].includes(url.protocol)) return null;
        if (url.username || url.password) return null;
        if (url.port && !["80", "443"].includes(url.port)) return null;
        if (isBlockedHost(url.hostname)) return null;
        url.hash = "";
        return url;
    } catch {
        return null;
    }
};

// ─── HTML metadata ────────────────────────────────────────────────────────────

const decodeEntities = (text) =>
    String(text || "")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ")
        .trim();

const parseMetaTags = (html) => {
    const meta = {};
    for (const [tag] of html.matchAll(/<meta\s[^>]*>/gi)) {
        const attrs = {};
        for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
            attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
        }
        const key = (attrs.property || attrs.name || "").toLowerCase();
        if (key && attrs.content && !(key in meta)) meta[key] = decodeEntities(attrs.content);
    }
    return meta;
};

const toAbsoluteHttpUrl = (value, base) => {
    if (!value) return null;
    try {
        const url = new URL(value, base);
        return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
    } catch {
        return null;
    }
};

const extractPreview = (html, finalUrl) => {
    const head = html.slice(0, 200000);
    const meta = parseMetaTags(head);
    const titleTag = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = meta["og:title"] || meta["twitter:title"] || (titleTag ? decodeEntities(titleTag[1]) : "");
    const description = meta["og:description"] || meta["twitter:description"] || meta.description || "";
    if (!title && !description) return null;

    return {
        url: finalUrl,
        title: title.slice(0, 200),
        description: description.slice(0, 300),
        image: toAbsoluteHttpUrl(meta["og:image"] || meta["twitter:image"], finalUrl),
        siteName: (meta["og:site_name"] || new URL(finalUrl).hostname.replace(/^www\./, "")).slice(0, 80),
    };
};

// ─── Fetch + cache ────────────────────────────────────────────────────────────

const cache = new Map();

const cacheSet = (key, value, ttl) => {
    if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
    cache.set(key, { value, expiresAt: Date.now() + ttl });
};

/**
 * Returns { url, title, description, image, siteName } or null. Never throws:
 * a missing preview must never block creating a post.
 */
const getLinkPreview = async (rawUrl) => {
    const url = normalizeUrl(rawUrl);
    if (!url) return null;
    const key = url.toString();

    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    try {
        const response = await axios.get(key, {
            timeout: FETCH_TIMEOUT_MS,
            maxContentLength: MAX_HTML_BYTES,
            maxRedirects: 3,
            responseType: "text",
            httpAgent,
            httpsAgent,
            beforeRedirect: (options) => {
                if (!["http:", "https:"].includes(options.protocol)) {
                    throw new Error("Redirect to unsupported protocol");
                }
                if (isBlockedHost(options.hostname)) {
                    throw new Error("Redirect to private address");
                }
            },
            headers: {
                "User-Agent": "Mozilla/5.0 (compatible; CliQLinkPreview/1.0)",
                Accept: "text/html,application/xhtml+xml",
            },
            validateStatus: (status) => status >= 200 && status < 300,
        });

        const contentType = String(response.headers["content-type"] || "");
        const finalUrl = response.request?.res?.responseUrl || key;
        const preview = contentType.includes("html") ? extractPreview(String(response.data || ""), finalUrl) : null;
        cacheSet(key, preview, preview ? CACHE_TTL_MS : FAILURE_TTL_MS);
        return preview;
    } catch (err) {
        logger.warn(`[LINK PREVIEW] ${key}: ${err.message}`);
        cacheSet(key, null, FAILURE_TTL_MS);
        return null;
    }
};

module.exports = { getLinkPreview, isPrivateAddress, extractPreview, normalizeUrl };
