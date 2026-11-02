const { app, prisma, request, PASSWORD, uniqueEmail, signedIn, createUser } = require("./helpers/app");

describe("profile edits", () => {
    it("refuses to change the email directly", async () => {
        const { browser } = await signedIn();
        const res = await browser.put("/profile/edit").send({ email: "new@example.com" });
        expect(res.status).toBe(400);
        expect(res.body.message).toMatch(/Invalid edit fields: email/);
    });

    it("updates name and age", async () => {
        const { browser } = await signedIn();
        const res = await browser.put("/profile/edit").send({ firstname: "  Grace ", age: "41" });
        expect(res.status).toBe(200);
        expect(res.body.user).toMatchObject({ firstname: "Grace", age: 41 });
    });

    it("needs the current password to set a new one", async () => {
        const { browser, user } = await signedIn();
        const without = await browser.put("/profile/edit").send({ password: "An0ther!pass" });
        expect(without.body.code).toBe("WRONG_PASSWORD");

        const ok = await browser.put("/profile/edit").send({ password: "An0ther!pass", currentPassword: PASSWORD });
        expect(ok.status).toBe(200);
        // This browser got a fresh session; the password works
        expect((await browser.get("/profile")).status).toBe(200);
        const login = await request(app).post("/login").send({ email: user.email, password: "An0ther!pass" });
        expect(login.status).toBe(200);
    });
});

describe("email change", () => {
    it("changes the email only after the code sent to the new address is entered", async () => {
        const { browser, user } = await signedIn();
        const newEmail = uniqueEmail("moved");

        const wrongPassword = await browser
            .post("/profile/email/change")
            .send({ newEmail, currentPassword: "Wrong!pass1" });
        expect(wrongPassword.body.code).toBe("WRONG_PASSWORD");

        const requested = await browser.post("/profile/email/change").send({ newEmail, currentPassword: PASSWORD });
        expect(requested.status).toBe(200);
        const sent = global.sentEmails.find((e) => e.kind === "otp");
        expect(sent.email).toBe(newEmail);
        // Nothing changed yet
        expect((await prisma.users.findUnique({ where: { id: user.id } })).email).toBe(user.email);

        const confirmed = await browser.post("/profile/email/confirm").send({ otp: sent.otp });
        expect(confirmed.status).toBe(200);
        expect(confirmed.body.user.email).toBe(newEmail);
        expect((await browser.get("/profile")).status).toBe(200);
    });

    it("refuses an address another account uses", async () => {
        const { browser } = await signedIn();
        const other = await createUser();
        const res = await browser
            .post("/profile/email/change")
            .send({ newEmail: other.email, currentPassword: PASSWORD });
        expect(res.status).toBe(409);
    });
});

describe("data export", () => {
    it("downloads the account's data without secrets", async () => {
        const { browser, user } = await signedIn();
        await prisma.post.create({ data: { content: "exported post", userId: user.id } });

        const res = await browser.get("/profile/export");
        expect(res.status).toBe(200);
        expect(res.headers["content-disposition"]).toMatch(/attachment; filename="cliq-data-/);
        expect(res.body.user.email).toBe(user.email);
        expect(res.body.user).not.toHaveProperty("password");
        expect(res.body.posts[0].content).toBe("exported post");
    });
});

describe("account deletion", () => {
    it("also removes the stored Get Connections list", async () => {
        const { browser, user } = await signedIn();
        await prisma.recommendationList.create({
            data: { userId: user.id, items: [], strategy: "ai", computedAt: new Date() },
        });

        const res = await browser.delete("/profile/delete");
        expect(res.status).toBe(200);
        expect(await prisma.users.findUnique({ where: { id: user.id } })).toBeNull();
        expect(await prisma.recommendationList.findUnique({ where: { userId: user.id } })).toBeNull();
    });
});

describe("connections list", () => {
    it("lists connections without their emails or account fields", async () => {
        const { browser, user } = await signedIn();
        const friend = await createUser();
        await prisma.connectionsRequest.create({
            data: { fromUserId: user.id, toUserId: friend.id, status: "accepted" },
        });

        const res = await browser.get("/myconnection");
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toMatchObject({ id: friend.id, firstname: friend.firstname });
        for (const field of ["email", "password", "role", "isBlocked", "tokenVersion"]) {
            expect(res.body[0]).not.toHaveProperty(field);
        }
    });
});
