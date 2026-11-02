// Builds the OpenAPI 3.1 document from the live routes: every path and method, whether it needs a
// session, its path parameters, and the request body / query schemas from validate(). Served at
// /api/docs (Swagger UI) and /api/docs/openapi.json; regenerate nothing by hand.
const { z } = require("zod");
const { schemasOf } = require("./registry");

const AUTH_MIDDLEWARE = {
    userAuth: "user",
    authenticateUser: "user",
    userAuthAllowBlocked: "user",
    adminAuth: "admin",
    optionalUserAuth: "optional",
};

// Short descriptions for routes whose handler name doesn't say enough on its own
const SUMMARIES = {
    "POST /auth/refresh": "Renew the access cookie using the refresh cookie (call after a TOKEN_EXPIRED 401)",
    "POST /auth/verify-otp": "Confirm a new account with the 6-digit emailed code (5 attempts per code)",
    "POST /auth/reset-password": "Set a new password with the emailed reset code (5 attempts per code)",
    "POST /profile/email/change": "Send a code to a new email address (needs the current password)",
    "POST /profile/email/confirm": "Apply the email change with the code sent to the new address",
    "GET /profile/export": "Download all of your data as JSON",
    "GET /post/feed": "Newest posts from everyone else (pass nextCursor back as cursor for the next page)",
    "GET /post/feed/following": "Newest posts from your connections (cursor-paginated)",
    "GET /post/feed/trending": "Most-liked posts of the last 30 days (page-numbered)",
};

const TAGS = [
    ["/auth", "Auth"],
    ["/login", "Auth"],
    ["/signup", "Auth"],
    ["/logout", "Auth"],
    ["/profile", "Profile"],
    ["/generate-ai-expertise", "Profile"],
    ["/aichat", "AI chat"],
    ["/message-ai", "Message assistant"],
    ["/chat", "Chat"],
    ["/notifications", "Notifications"],
    ["/request", "Connections"],
    ["/myconnection", "Connections"],
    ["/user/connections", "Connections"],
    ["/user/requests", "Connections"],
    ["/search", "Search"],
    ["/user/search", "Search"],
    ["/post", "Posts"],
    ["/user/post", "Posts"],
    ["/create/post", "Posts"],
    ["/delete/post", "Posts"],
    ["/update/post", "Posts"],
    ["/user", "Users"],
    ["/users", "Users"],
    ["/link-preview", "Posts"],
];

const tagFor = (path) => TAGS.find(([prefix]) => path === prefix || path.startsWith(`${prefix}/`))?.[1] || "Other";

// "getFollowingFeed" -> "Get following feed"
const humanise = (name) => {
    const words = String(name || "")
        .replace(/^bound /, "")
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase();
    return words ? words[0].toUpperCase() + words.slice(1) : "";
};

const toJsonSchema = (schema, io) => {
    try {
        return z.toJSONSchema(schema, { io, unrepresentable: "any" });
    } catch {
        return { type: "object" };
    }
};

// Walks nested routers (all mounted at "/") and yields every route with its middleware chain
function* walk(stack) {
    for (const layer of stack) {
        if (layer.route) {
            yield layer.route;
        } else if (layer.handle?.stack) {
            yield* walk(layer.handle.stack);
        }
    }
}

const buildOpenApiDocument = (router) => {
    const paths = {};

    for (const route of walk(router.stack)) {
        const rawPath = String(route.path);
        const path = rawPath.replace(/:(\w+)/g, "{$1}");
        const params = [...rawPath.matchAll(/:(\w+)/g)].map(([, name]) => ({
            name,
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[0-9a-fA-F]{24}$" },
        }));

        for (const method of Object.keys(route.methods)) {
            const handlers = route.stack.map((layer) => layer.handle);
            const names = handlers.map((handle) => handle.name);
            const auth = names.map((name) => AUTH_MIDDLEWARE[name]).find(Boolean);
            const schemas = Object.assign({}, ...handlers.map((handle) => schemasOf(handle) || {}));
            const isUpload = rawPath === "/create/post" || rawPath.endsWith("/image") || rawPath === "/chat/upload";
            const key = `${method.toUpperCase()} ${rawPath}`;

            const operation = {
                tags: [tagFor(rawPath)],
                summary: SUMMARIES[key] || humanise(names[names.length - 1]),
                parameters: [...params],
                responses: {
                    200: { description: "Success" },
                    400: { $ref: "#/components/responses/BadRequest" },
                    ...(auth && auth !== "optional" ? { 401: { $ref: "#/components/responses/Unauthorized" } } : {}),
                    429: { $ref: "#/components/responses/RateLimited" },
                },
            };
            if (auth === "user" || auth === "admin") operation.security = [{ cookieAuth: [] }];
            if (auth === "admin") operation.description = "Admins only.";

            if (schemas.query) {
                const json = toJsonSchema(schemas.query, "input");
                for (const [name, schema] of Object.entries(json.properties || {})) {
                    operation.parameters.push({ name, in: "query", required: false, schema });
                }
            }
            if (schemas.body) {
                operation.requestBody = {
                    required: true,
                    content: { "application/json": { schema: toJsonSchema(schemas.body, "input") } },
                };
            } else if (isUpload) {
                operation.requestBody = {
                    content: { "multipart/form-data": { schema: { type: "object" } } },
                };
            }

            paths[path] = { ...paths[path], [method]: operation };
        }
    }

    const errorSchema = {
        type: "object",
        properties: {
            message: { type: "string" },
            code: { type: "string", description: "e.g. VALIDATION_ERROR, TOKEN_EXPIRED, OTP_LOCKED, RATE_LIMITED" },
            errors: {
                type: "array",
                items: { type: "object", properties: { path: { type: "string" }, message: { type: "string" } } },
            },
        },
    };

    return {
        openapi: "3.1.0",
        info: {
            title: "CliQ API",
            version: "1.0.0",
            description:
                "Sessions are httpOnly cookies set by /login (auth_token, ~15 min, renewed via POST /auth/refresh with the refresh_token cookie). " +
                "Changing requests from a browser must come from an allowed Origin. Errors are JSON: { message, code?, errors? }.",
        },
        components: {
            securitySchemes: { cookieAuth: { type: "apiKey", in: "cookie", name: "auth_token" } },
            schemas: { Error: errorSchema },
            responses: {
                BadRequest: {
                    description: "Invalid input",
                    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
                },
                Unauthorized: {
                    description: "No session, or it expired (code TOKEN_EXPIRED: call POST /auth/refresh and retry)",
                    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
                },
                RateLimited: {
                    description: "Too many requests",
                    content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
                },
            },
        },
        paths,
    };
};

module.exports = { buildOpenApiDocument };
