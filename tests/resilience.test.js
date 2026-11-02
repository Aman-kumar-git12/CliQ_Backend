// What users see when the optional services are down: the tests point Redis and the AI agent at closed
// ports (tests/helpers/env.js), so every call here meets a dead service, as on a bad day in production.
const { prisma, signedIn, createUser, connect } = require("./helpers/app");
const redisClient = require("../src/config/redisClient");
const { saveStoredList, markStoredListsStale, loadStoredList } = require("../src/utils/recommendations/storedList");
const { isPlaceholderText } = require("../src/utils/recommendations/constants");
const { isDiscoverableProfile } = require("../src/utils/recommendations");

const timed = async (promise) => {
    const startedAt = Date.now();
    const result = await promise;
    return { result, ms: Date.now() - startedAt };
};

describe("Redis unreachable", () => {
    it("gives up on Redis within a couple of seconds, then skips it without waiting", async () => {
        const first = await timed(redisClient.ensureReady());
        expect(first.result).toBe(false);
        expect(first.ms).toBeLessThan(2500);

        const again = await timed(redisClient.ensureReady());
        expect(again.result).toBe(false);
        expect(again.ms).toBeLessThan(50);
    });

    it("still answers Get Connections quickly", async () => {
        const { browser } = await signedIn();
        await createUser({ expertise: { description: "Backend engineer", skills: ["Node.js"] } });

        const { result: res, ms } = await timed(browser.get("/request/smart-users"));
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(ms).toBeLessThan(3000);
    });
});

describe("AI agent down", () => {
    it("falls back to keyword search at once", async () => {
        const { browser } = await signedIn();
        await createUser({ firstname: "Kundan", expertise: { skills: ["React"], description: "Frontend dev" } });

        const first = await browser.get("/search?q=react developers&type=people&semantic=on");
        expect(first.status).toBe(200);
        expect(first.body.semantic).toEqual({ used: false, available: false });
        expect(first.body.people.some((p) => p.firstname === "Kundan")).toBe(true);
        expect(first.body.people[0]).not.toHaveProperty("email");

        // The failure is remembered for a minute: later searches don't try the agent again
        const { result: second, ms } = await timed(browser.get("/search?q=react developers&type=people&semantic=on"));
        expect(second.body.semantic.available).toBe(false);
        expect(ms).toBeLessThan(1000);
    });

    it("answers reply suggestions with a 502 that doesn't reveal the agent's address", async () => {
        const { browser, user } = await signedIn();
        const friend = await createUser();
        await connect(user, friend);

        const res = await browser.post(`/message-ai/conversation/${friend.id}`).send({ mode: "replies" });
        expect(res.status).toBe(502);
        expect(res.body.reason).toBe("agent unreachable");
        expect(JSON.stringify(res.body)).not.toContain("127.0.0.1");

        const ask = await browser.post(`/message-ai/conversation/${friend.id}`).send({ mode: "ask", question: "hi?" });
        expect(ask.status).toBe(200);
        expect(ask.body.source).toBe("fallback");
    });

    it("fails AI expertise drafting with a clear gateway error", async () => {
        const { browser } = await signedIn();
        const res = await browser
            .post("/generate-ai-expertise")
            .send({ answers: { about: "I build web apps with React and Node." } });
        expect(res.status).toBe(502);
        expect(res.body.code).toBe("AI_UNAVAILABLE");
    });

    it("ends the AI help chat stream with an offline message", async () => {
        const { browser } = await signedIn();
        const session = (await browser.post("/aichat/session")).body.session;

        const res = await browser.post("/aichat/stream").send({ sessionId: session.id, message: "How do I post?" });
        expect(res.status).toBe(200);
        expect(res.text).toContain("event: error");
        expect(res.text).toContain("offline");
        expect(res.text).toContain("event: done");
    });
});

describe("stored Get Connections lists", () => {
    const payload = (ids) => ({ strategy: "ai", users: ids.map((id) => ({ id, matchScore: 0.9 })) });

    it("stays stale when a change was marked while the ranking ran", async () => {
        const user = await createUser();
        const candidate = await createUser();
        await saveStoredList(user.id, payload([candidate.id]));

        const rankedFrom = new Date();
        await new Promise((resolve) => setTimeout(resolve, 5));
        await markStoredListsStale([user.id]); // e.g. a new connection while the agent was ranking
        const { stale } = await saveStoredList(user.id, payload([candidate.id]), { rankedFrom });

        expect(stale).toBe(true);
        expect((await loadStoredList(user.id)).isStale).toBe(true);
    });

    it("is fresh again when the ranking started after the change", async () => {
        const user = await createUser();
        const candidate = await createUser();
        await saveStoredList(user.id, payload([candidate.id]));
        await markStoredListsStale([user.id]);
        await new Promise((resolve) => setTimeout(resolve, 5));

        const { stale } = await saveStoredList(user.id, payload([candidate.id]), { rankedFrom: new Date() });
        expect(stale).toBe(false);
        expect((await loadStoredList(user.id)).isStale).toBe(false);
    });
});

describe("profile placeholders", () => {
    it("treats any run of asterisks as an empty field", () => {
        expect(isPlaceholderText("*******")).toBe(true);
        expect(isPlaceholderText(" **** ")).toBe(true);
        expect(isPlaceholderText("C*")).toBe(false);
        expect(isPlaceholderText("React")).toBe(false);
    });

    it("keeps a fresh signup profile out of Get Connections", () => {
        const signupDefaults = {
            name: "New Person",
            description: "*******",
            experience: "*******",
            skills: ["*******", "*******"],
            projects: "*******",
            achievements: "*******",
            interests: "*******",
            aboutYou: "*******",
            details: { email: "new@example.com", address: "*******" },
            format: 1,
        };
        expect(isDiscoverableProfile(signupDefaults)).toBe(false);
    });
});

describe("double clicks", () => {
    it("likes a post once when two likes race", async () => {
        // The in-memory database has no schema indexes; production has this unique one
        await prisma.$runCommandRaw({
            createIndexes: "Like",
            indexes: [{ key: { userId: 1, postId: 1 }, name: "Like_userId_postId_key", unique: true }],
        });
        const { browser, user } = await signedIn();
        const author = await createUser();
        const post = await prisma.post.create({ data: { content: "like me", userId: author.id } });

        const responses = await Promise.all([
            browser.post(`/user/post/like/${post.id}`),
            browser.post(`/user/post/like/${post.id}`),
        ]);
        expect(responses.map((r) => r.status)).toEqual([200, 200]);
        expect(await prisma.like.count({ where: { postId: post.id, userId: user.id } })).toBe(1);
    });
});

describe("hover card", () => {
    it("tells an incoming request from an outgoing one", async () => {
        const { browser, user } = await signedIn();
        const sender = await createUser();
        const receiver = await createUser();
        const stranger = await createUser();
        await prisma.connectionsRequest.create({ data: { fromUserId: sender.id, toUserId: user.id } });
        await prisma.connectionsRequest.create({ data: { fromUserId: user.id, toUserId: receiver.id } });

        const card = async (id) => (await browser.get(`/user/hover-card/${id}`)).body;
        expect(await card(sender.id)).toMatchObject({ connectionStatus: "interested", requestDirection: "incoming" });
        expect(await card(receiver.id)).toMatchObject({ connectionStatus: "interested", requestDirection: "outgoing" });
        expect(await card(stranger.id)).toMatchObject({ connectionStatus: "none", requestDirection: null });
    });
});

describe("message assistant", () => {
    it("forwards the emoji preference to the agent", async () => {
        const axios = require("axios");
        const post = jest.spyOn(axios, "post").mockResolvedValue({ data: { reply_suggestions: ["Sure!"] } });
        try {
            const { browser, user } = await signedIn();
            const friend = await createUser();
            await connect(user, friend);

            const res = await browser
                .post(`/message-ai/conversation/${friend.id}`)
                .send({ mode: "replies", emojiPreference: "without" });
            expect(res.status).toBe(200);
            const [url, body] = post.mock.calls.find(([calledUrl]) => calledUrl.endsWith("/api/message-ai/respond"));
            expect(url).toMatch(/\/api\/message-ai\/respond$/);
            expect(body.emojiPreference).toBe("without");
        } finally {
            post.mockRestore();
        }
    });
});
