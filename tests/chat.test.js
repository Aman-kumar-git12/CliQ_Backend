const http = require("http");
const { app, prisma, request, PASSWORD, createUser, signedIn, connect } = require("./helpers/app");
const { initialiseSocket } = require("../src/socket/socket");

// ── A minimal Socket.IO client over Node's built-in WebSocket (no extra dependency) ──
// Engine.IO v4 packets: "0" open, "2"/"3" ping/pong; Socket.IO packets inside "4": "0" connect, "2" event, "3" ack
const authCookie = async (user) => {
    const res = await request(app).post("/login").send({ email: user.email, password: PASSWORD });
    const cookie = (res.headers["set-cookie"] || []).find((c) => c.startsWith("auth_token="));
    return cookie.split(";")[0];
};

const openSocket = (port, cookie) =>
    new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`, {
            headers: { cookie },
        });
        const client = { ws, events: [], acks: new Map(), nextAck: 1 };
        ws.onmessage = ({ data }) => {
            const packet = String(data);
            if (packet.startsWith("0")) ws.send("40");
            else if (packet === "2") ws.send("3");
            else if (packet.startsWith("40")) resolve(client);
            else if (packet.startsWith("44")) reject(new Error(packet));
            else if (packet.startsWith("42")) client.events.push(JSON.parse(packet.slice(2)));
            else if (packet.startsWith("43")) {
                const [, id, body] = packet.match(/^43(\d+)(.*)$/);
                client.acks.get(Number(id))?.(JSON.parse(body)[0]);
            }
        };
        ws.onerror = () => reject(new Error("socket failed"));
    });

const emit = (client, ...args) => client.ws.send(`42${JSON.stringify(args)}`);

const emitWithAck = (client, ...args) =>
    new Promise((resolve, reject) => {
        const id = client.nextAck++;
        const timer = setTimeout(() => reject(new Error(`no ack for ${args[0]}`)), 5000);
        client.acks.set(id, (body) => {
            clearTimeout(timer);
            resolve(body);
        });
        client.ws.send(`42${id}${JSON.stringify(args)}`);
    });

// Other files delete users wholesale; a reply (a NoAction self-relation) left behind would block that
afterAll(async () => {
    await prisma.message.updateMany({ data: { parentMessageId: null } });
    await prisma.message.deleteMany({});
    await prisma.conversation.deleteMany({});
});

describe("chat socket", () => {
    let server;
    let port;
    const crashes = [];
    const recordCrash = (err) => crashes.push(err);

    beforeAll(async () => {
        server = http.createServer(app);
        initialiseSocket(server);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        port = server.address().port;
        process.on("unhandledRejection", recordCrash);
        process.on("uncaughtException", recordCrash);
    });

    afterAll(async () => {
        process.off("unhandledRejection", recordCrash);
        process.off("uncaughtException", recordCrash);
        await new Promise((resolve) => server.close(resolve));
    });

    it("answers malformed events instead of crashing the server", async () => {
        const user = await createUser();
        const client = await openSocket(port, await authCookie(user));

        // Before the fix each of these threw inside a handler: an unhandled rejection, which exits the process
        emit(client, "checkStatus");
        emit(client, "joinChat");
        emit(client, "leaveChat", null);
        emit(client, "sendMessage");
        emit(client, "sendMessage", { targetuserId: "x" }, "not-a-callback");

        expect(await emitWithAck(client, "sendMessage", null)).toMatchObject({ success: false });
        expect(await emitWithAck(client, "sendMessage", { targetuserId: user.id, text: 42 })).toMatchObject({
            success: false,
        });
        // Connected, so online (Redis is down in the tests: presence falls back to memory)
        expect(await emitWithAck(client, "checkStatus", { userId: user.id })).toEqual({
            userId: user.id,
            status: "online",
        });
        expect(crashes).toEqual([]);
        client.ws.close();
    });

    it("shows a user online while any socket is open and offline after the last one closes", async () => {
        const watcher = await openSocket(port, await authCookie(await createUser()));
        const user = await createUser();
        const cookie = await authCookie(user);
        const tab1 = await openSocket(port, cookie);
        const tab2 = await openSocket(port, cookie);
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(watcher.events).toContainEqual(["statusUpdate", { userId: user.id, status: "online" }]);

        tab1.ws.close();
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect(await emitWithAck(watcher, "checkStatus", { userId: user.id })).toMatchObject({ status: "online" });

        tab2.ws.close();
        await new Promise((resolve) => setTimeout(resolve, 200));
        const { status } = await emitWithAck(watcher, "checkStatus", { userId: user.id });
        expect(status).toMatch(/^\d{13}$/); // last seen, in ms
        expect(crashes).toEqual([]);
        watcher.ws.close();
    });

    it("delivers a message between connections and refuses strangers and foreign replies", async () => {
        const alice = await createUser({ firstname: "Alice" });
        const bob = await createUser({ firstname: "Bob" });
        const stranger = await createUser();
        await connect(alice, bob);

        const aliceSocket = await openSocket(port, await authCookie(alice));
        const bobSocket = await openSocket(port, await authCookie(bob));
        emit(bobSocket, "joinChat", { targetuserId: alice.id });
        await new Promise((resolve) => setTimeout(resolve, 100));

        const sent = await emitWithAck(aliceSocket, "sendMessage", { targetuserId: bob.id, text: "hi Bob" });
        expect(sent).toMatchObject({ success: true });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(bobSocket.events).toContainEqual(["receiveMessage", expect.objectContaining({ text: "hi Bob" })]);

        expect(
            await emitWithAck(aliceSocket, "sendMessage", { targetuserId: stranger.id, text: "hello" }),
        ).toMatchObject({ success: false, error: "You can only message your connections" });

        // A message from a conversation Alice isn't part of can't be quoted into hers
        const otherConversation = await prisma.conversation.create({
            data: { participantIds: [bob.id, stranger.id] },
        });
        const secret = await prisma.message.create({
            data: { conversationId: otherConversation.id, senderId: stranger.id, text: "secret" },
        });
        const reply = await emitWithAck(aliceSocket, "sendMessage", {
            targetuserId: bob.id,
            text: "quoting",
            parentMessageId: secret.id,
        });
        expect(reply).toMatchObject({ success: false });

        expect(crashes).toEqual([]);
        aliceSocket.ws.close();
        bobSocket.ws.close();
    });
});

describe("chat REST", () => {
    const setUpChat = async () => {
        const { browser, user } = await signedIn();
        const friend = await createUser();
        await connect(user, friend);
        const conversation = await prisma.conversation.create({
            data: { participantIds: [user.id, friend.id] },
        });
        const say = (senderId, data) =>
            // The socket always stores deletedById, so fixtures do too
            prisma.message.create({ data: { conversationId: conversation.id, senderId, deletedById: [], ...data } });
        return { browser, user, friend, conversation, say };
    };

    it("lists conversations with the last visible message", async () => {
        const { browser, user, friend, say } = await setUpChat();
        await say(friend.id, { text: "first", createdAt: new Date(Date.now() - 3000) });
        await say(user.id, { text: "second", createdAt: new Date(Date.now() - 2000) });
        await say(friend.id, { text: "gone", isDelete: true, createdAt: new Date(Date.now() - 1000) });
        await say(friend.id, { text: "hidden for me", deletedById: [user.id] });

        const res = await browser.get("/chat/conversations");
        expect(res.status).toBe(200);
        const chat = res.body.find((c) => c.targetUserId === friend.id);
        expect(chat.lastMessage).toBe("second");
    });

    it("hides the content of messages deleted for everyone", async () => {
        const { browser, user, friend, say } = await setUpChat();
        const photo = await say(friend.id, { image: "https://res.cloudinary.com/x/photo.jpg", isDelete: true });
        await say(user.id, { text: "replying", parentMessageId: photo.id });

        const res = await browser.get(`/chat/history/${friend.id}`);
        expect(res.status).toBe(200);
        const deleted = res.body.find((m) => m.id === photo.id);
        expect(deleted).toMatchObject({ text: "This message is deleted", image: null });
        expect(deleted).not.toHaveProperty("deletedById");
        expect(res.body.find((m) => m.text === "replying").parentMessage.text).toBe("This message is deleted");
    });

    it("only lets users act on messages in their own conversations", async () => {
        const { browser, friend, say } = await setUpChat();
        const theirs = await say(friend.id, { text: "mine" });
        const outsider = await signedIn();

        expect((await outsider.browser.delete(`/chat/message/${theirs.id}`)).status).toBe(404);
        // A participant who isn't the sender can't edit it
        expect((await browser.put(`/chat/message/${theirs.id}`).send({ text: "edited" })).status).toBe(403);
        expect((await prisma.message.findUnique({ where: { id: theirs.id } })).deletedById).toEqual([]);
    });

    it("bulk-deletes in one pass: for everyone only what the user sent", async () => {
        const { browser, user, friend, say } = await setUpChat();
        const mine = await say(user.id, { text: "mine" });
        const theirs = await say(friend.id, { text: "theirs" });
        const outsiderMessage = await prisma.message.create({
            data: {
                conversationId: (await prisma.conversation.create({ data: { participantIds: [friend.id] } })).id,
                senderId: friend.id,
                text: "elsewhere",
                deletedById: [],
            },
        });

        const res = await browser
            .post("/chat/delete-bulk")
            .send({ messageIds: [mine.id, theirs.id, outsiderMessage.id], deleteType: "everyone" });
        expect(res.status).toBe(200);

        const [mineAfter, theirsAfter, outsiderAfter] = await Promise.all(
            [mine, theirs, outsiderMessage].map((m) => prisma.message.findUnique({ where: { id: m.id } })),
        );
        expect(mineAfter.isDelete).toBe(true);
        expect(theirsAfter).toMatchObject({ isDelete: false, deletedById: [user.id] });
        expect(outsiderAfter).toMatchObject({ isDelete: false, deletedById: [] });
    });
});
