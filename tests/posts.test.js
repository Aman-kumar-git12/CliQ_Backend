const { prisma, signedIn, createUser, connect } = require("./helpers/app");

const makePosts = async (userId, count) => {
    for (let i = 0; i < count; i += 1) {
        await prisma.post.create({
            data: { content: `post ${i}`, userId, createdAt: new Date(Date.now() - i * 1000) },
        });
    }
};

describe("posts", () => {
    it("creates a text post and validates edits", async () => {
        const { browser } = await signedIn();
        const created = await browser.post("/create/post").field("content", "hello #world");
        expect(created.status).toBe(200);

        const empty = await browser.put(`/update/post/${created.body.id}`).send({ content: "   " });
        expect(empty.status).toBe(400);
        const tooLong = await browser.put(`/update/post/${created.body.id}`).send({ content: "x".repeat(501) });
        expect(tooLong.status).toBe(400);
    });

    it("validates comments and reports", async () => {
        const { browser, user } = await signedIn();
        const post = await prisma.post.create({ data: { content: "c", userId: user.id } });
        expect((await browser.post(`/user/post/comments/${post.id}`).send({ comment: "" })).status).toBe(400);
        expect((await browser.post(`/user/post/comments/${post.id}`).send({ comment: "nice" })).status).toBe(200);
        expect((await browser.post(`/user/post/report/${post.id}`).send({})).status).toBe(400);
    });

    it("rejects malformed ids before they reach the database", async () => {
        const { browser } = await signedIn();
        expect((await browser.post("/post/feed/random").send({ excludeIds: ["nope"] })).status).toBe(400);
        expect((await browser.get("/user/post/not-an-id")).status).toBe(400);
    });

    it("pages the following feed with a cursor, without gaps or repeats", async () => {
        const { browser, user } = await signedIn();
        const friend = await createUser();
        const stranger = await createUser();
        await connect(user, friend);
        await makePosts(friend.id, 7);
        await makePosts(stranger.id, 2);

        const first = await browser.get("/post/feed/following?limit=3");
        expect(first.body.posts).toHaveLength(3);
        expect(first.body.hasMore).toBe(true);

        const seen = first.body.posts.map((p) => p.id);
        let cursor = first.body.nextCursor;
        while (cursor) {
            const next = await browser.get(`/post/feed/following?limit=3&cursor=${cursor}`);
            seen.push(...next.body.posts.map((p) => p.id));
            cursor = next.body.nextCursor;
        }
        expect(seen).toHaveLength(7);
        expect(new Set(seen).size).toBe(7);
    });

    it("still supports page numbers for older clients", async () => {
        const { browser } = await signedIn();
        const res = await browser.get("/post/feed?page=1&limit=2");
        expect(res.status).toBe(200);
        expect(res.body.page).toBe(1);
        expect(res.body).toHaveProperty("nextCursor");
    });
});
