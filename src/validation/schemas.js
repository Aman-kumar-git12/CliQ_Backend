// Request shapes for every route that takes input. validate() checks a request against one of these
// before the controller runs, and the API docs (src/docs/openapi.js) are generated from the same schemas.
const { z } = require("zod");

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, "Invalid ID format");
const email = z
    .string({ error: "Email is required" })
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: "Invalid email format" }).max(254));
const otp = z
    .string({ error: "The 6-digit code is required" })
    .trim()
    .regex(/^\d{6}$/, "The code must be 6 digits");
// Same rule as validator.isStrongPassword, which the signup form has always enforced
const strongPassword = z
    .string({ error: "Password is required" })
    .min(8, "Password must be at least 8 characters")
    .max(128, "Password must be at most 128 characters")
    .regex(/[a-z]/, "Password needs a lowercase letter")
    .regex(/[A-Z]/, "Password needs an uppercase letter")
    .regex(/[0-9]/, "Password needs a number")
    .regex(/[^A-Za-z0-9]/, "Password needs a symbol");
const name = (label) =>
    z
        .string({ error: `${label} is required` })
        .trim()
        .min(1, `${label} is required`)
        .max(50, `${label} must be at most 50 characters`);
const age = z.coerce
    .number({ error: "Age is required" })
    .int("Age must be a whole number")
    .min(13, "Age must be at least 13 years")
    .max(120, "Age must be at most 120");
const text = (max, label = "Text") => z.string().trim().max(max, `${label} must be at most ${max} characters`);

// ── Auth ─────────────────────────────────────────────────────────────────────
const signup = z.object({
    firstname: name("First name"),
    lastname: name("Last name"),
    email,
    password: strongPassword,
    age,
});
const login = z.object({ email, password: z.string({ error: "Password is required" }).min(1).max(128) });
const emailOnly = z.object({ email });
const verifyOtp = z.object({ email, otp });
const resetPassword = z.object({
    email,
    otp,
    newPassword: z.string().min(8, "New password must be at least 8 characters long.").max(128),
});
const unblockRequest = z.object({ email, message: text(1000, "Message").min(1, "Message is required") });

// ── Profile ──────────────────────────────────────────────────────────────────
// strict: an unknown field (including "email", which has its own verified flow) is an error, not ignored
const profileEdit = z.strictObject(
    {
        firstname: name("First name").optional(),
        lastname: name("Last name").optional(),
        age: age.optional(),
        imageUrl: z
            .url({ protocol: /^https$/ })
            .max(2048)
            .optional(),
        password: strongPassword.optional(),
        currentPassword: z.string().max(128).optional(),
    },
    {
        error: (issue) =>
            issue.code === "unrecognized_keys" ? `Invalid edit fields: ${issue.keys.join(", ")}` : undefined,
    },
);
const emailChangeRequest = z.object({
    newEmail: email,
    currentPassword: z.string({ error: "Your current password is required" }).min(1).max(128),
});
const emailChangeConfirm = z.object({ otp });

// ── Posts ────────────────────────────────────────────────────────────────────
const mentionIds = z.union([z.array(objectId).max(50), z.string()]).optional();
const postUpdate = z.object({
    content: text(500, "Content").min(1, "Content is required"),
    mentionIds,
});
const comment = z.object({
    comment: text(1000, "Comment").min(1, "Comment is required"),
    parentId: objectId.optional().nullable(),
    mentionIds,
});
const report = z.object({ reason: text(500, "Reason").min(1, "A reason is required") });
const randomFeed = z.object({ excludeIds: z.array(objectId).max(500).default([]) });

// ── Chat ─────────────────────────────────────────────────────────────────────
const messageUpdate = z.object({ text: text(5000, "Message").optional(), isDelete: z.boolean().optional() });
const messageBulkDelete = z.object({
    messageIds: z.array(objectId).min(1).max(200),
    deleteType: z.enum(["me", "everyone"]).default("me"),
});

// ── AI ───────────────────────────────────────────────────────────────────────
// Loose: these controllers already check their own fields; this only bounds sizes and types
const aiStream = z.looseObject({
    message: z.string().max(4000).optional(),
    sessionId: objectId.optional().nullable(),
    currentPath: z.string().max(300).optional().nullable(),
    regenerate: z.boolean().optional(),
});
const aiSave = z.object({ sessionId: objectId, role: z.enum(["user", "ai"]), text: z.string().min(1).max(20000) });
const aiFeedback = z.object({
    feedback: z.union([z.literal(1), z.literal(-1), z.null()]),
    note: z.string().max(500).optional().nullable(),
});
const messageAssistant = z.looseObject({
    question: z.string().max(4000).optional(),
    draft: z.string().max(4000).optional(),
    tone: z.string().max(40).optional(),
    mode: z.string().max(40).optional(),
    emojiPreference: z.string().max(20).optional(),
});

// ── Query strings (checked, not rewritten: Express 5 makes req.query read-only) ──
const pageQuery = z.looseObject({
    page: z.coerce.number().int().min(1).max(10000).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
    cursor: objectId.optional(),
});
const searchQuery = z.looseObject({
    q: z.string().max(100, "Searches can be at most 100 characters").optional(),
    type: z.enum(["all", "people", "posts", "hashtags"]).optional(),
    limit: z.coerce.number().int().min(1).max(50).optional(),
});

module.exports = {
    objectId,
    signup,
    login,
    emailOnly,
    verifyOtp,
    resetPassword,
    unblockRequest,
    profileEdit,
    emailChangeRequest,
    emailChangeConfirm,
    postUpdate,
    comment,
    report,
    randomFeed,
    messageUpdate,
    messageBulkDelete,
    aiStream,
    aiSave,
    aiFeedback,
    messageAssistant,
    pageQuery,
    searchQuery,
};
