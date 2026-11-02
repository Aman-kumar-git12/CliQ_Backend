const jwt = require("jsonwebtoken");
const { app, prisma, request, PASSWORD, uniqueEmail, createUser, signedIn, cookieNames } = require("./helpers/app");

const lastCode = () => global.sentEmails[global.sentEmails.length - 1]?.otp;

const signupBody = (email) => ({ firstname: "Ada", lastname: "Lovelace", email, password: PASSWORD, age: 30 });

describe("signup and email verification", () => {
    it("validates the signup form", async () => {
        const res = await request(app)
            .post("/signup")
            .send({ ...signupBody("not-an-email"), password: "weak", age: 9 });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("VALIDATION_ERROR");
        expect(res.body.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["email", "password", "age"]));
    });

    it("signs up, emails a code, and the code verifies and signs in", async () => {
        const email = uniqueEmail("signup");
        const created = await request(app).post("/signup").send(signupBody(email.toUpperCase()));
        expect(created.status).toBe(201);
        expect(created.body.email).toBe(email); // normalised to lower case
        expect(global.sentEmails).toHaveLength(1);

        const browser = request.agent(app);
        const verified = await browser.post("/auth/verify-otp").send({ email, otp: lastCode() });
        expect(verified.status).toBe(200);
        expect(cookieNames(verified)).toEqual(expect.arrayContaining(["auth_token", "refresh_token"]));
        expect((await browser.get("/auth/me")).body.user.email).toBe(email);
    });

    it("locks a code after 5 wrong guesses", async () => {
        const email = uniqueEmail("lock");
        await request(app).post("/signup").send(signupBody(email));
        const code = lastCode();
        const wrong = code === "000000" ? "111111" : "000000";

        for (let i = 1; i <= 4; i += 1) {
            const res = await request(app).post("/auth/verify-otp").send({ email, otp: wrong });
            expect(res.status).toBe(400);
            expect(res.body.message).toMatch(`${5 - i} attempt`);
        }
        const locked = await request(app).post("/auth/verify-otp").send({ email, otp: wrong });
        expect(locked.body.code).toBe("OTP_LOCKED");

        // The right code no longer works either: a new one must be requested
        const tooLate = await request(app).post("/auth/verify-otp").send({ email, otp: code });
        expect(tooLate.status).toBe(400);
        expect(tooLate.body.code).toBe("OTP_EXPIRED");
    });

    it("never signs in to an already-verified account through verify-otp", async () => {
        const user = await createUser();
        const res = await request(app).post("/auth/verify-otp").send({ email: user.email, otp: "123456" });
        expect(res.status).toBe(400);
        expect(cookieNames(res)).not.toContain("auth_token");
    });
});

describe("login and sessions", () => {
    it("rejects a wrong password and signs in with the right one", async () => {
        const user = await createUser();
        const wrong = await request(app).post("/login").send({ email: user.email, password: "Wrong!pass1" });
        expect(wrong.status).toBe(401);

        const ok = await request(app).post("/login").send({ email: user.email, password: PASSWORD });
        expect(ok.status).toBe(200);
        expect(ok.body.user).not.toHaveProperty("password");
        expect(cookieNames(ok)).toEqual(expect.arrayContaining(["auth_token", "refresh_token"]));
        const refreshCookie = ok.headers["set-cookie"].find((c) => c.startsWith("refresh_token="));
        expect(refreshCookie).toMatch(/Path=\/auth/);
        expect(refreshCookie).toMatch(/HttpOnly/);
    });

    it("issues short-lived access tokens", async () => {
        const user = await createUser();
        const res = await request(app).post("/login").send({ email: user.email, password: PASSWORD });
        const token = res.headers["set-cookie"]
            .find((c) => c.startsWith("auth_token="))
            .split(";")[0]
            .split("=")[1];
        const { exp, iat } = jwt.decode(token);
        expect(exp - iat).toBe(15 * 60);
    });

    it("answers an expired access token with TOKEN_EXPIRED, and refresh renews it", async () => {
        const { browser, user } = await signedIn();
        const expired = jwt.sign(
            { userId: user.id, tv: 0, exp: Math.floor(Date.now() / 1000) - 10 },
            "test-jwt-secret",
        );
        browser.jar.setCookie(`auth_token=${expired}; Path=/`, "127.0.0.1");

        const rejected = await browser.get("/profile");
        expect(rejected.status).toBe(401);
        expect(rejected.body.code).toBe("TOKEN_EXPIRED");
        // /auth/me must not pretend the browser is signed out
        expect((await browser.get("/auth/me")).body.code).toBe("TOKEN_EXPIRED");

        const renewed = await browser.post("/auth/refresh");
        expect(renewed.status).toBe(200);
        expect((await browser.get("/profile")).status).toBe(200);
    });

    it("rotates the refresh token and ends the family when an old one is replayed", async () => {
        const { browser, user } = await signedIn();
        const first = await browser.post("/auth/refresh");
        expect(first.status).toBe(200);
        // The browser uses its new token, so the replaced one can only come from a copy
        expect((await browser.post("/auth/refresh")).status).toBe(200);

        // Replay the token that was just replaced, after the 30s grace window
        const [oldToken] = await prisma.refreshToken.findMany({
            where: { userId: user.id, revokedAt: { not: null } },
            orderBy: { createdAt: "asc" },
        });
        await prisma.refreshToken.update({
            where: { id: oldToken.id },
            data: { revokedAt: new Date(Date.now() - 60 * 1000) },
        });
        // The raw old value isn't stored, so replay it by hash: point a copied cookie at the old record
        const thief = request.agent(app);
        const stolen = "replayed-token-value";
        const crypto = require("crypto");
        await prisma.refreshToken.update({
            where: { id: oldToken.id },
            data: { tokenHash: crypto.createHash("sha256").update(stolen).digest("hex") },
        });
        thief.jar.setCookie(`refresh_token=${stolen}; Path=/auth`, "127.0.0.1");
        expect((await thief.post("/auth/refresh")).status).toBe(401);

        // The legitimate browser's session in that family is gone too
        expect(await prisma.refreshToken.count({ where: { familyId: oldToken.familyId } })).toBe(0);
        expect((await browser.post("/auth/refresh")).status).toBe(401);
    });

    it("tolerates two tabs renewing at the same moment", async () => {
        const { browser } = await signedIn();
        const cookies = browser.jar.getCookies({ domain: "127.0.0.1", path: "/auth", secure: false, script: false });
        const refreshCookie = cookies.find((c) => c.name === "refresh_token").value;

        const otherTab = request.agent(app);
        otherTab.jar.setCookie(`refresh_token=${refreshCookie}; Path=/auth`, "127.0.0.1");

        expect((await browser.post("/auth/refresh")).status).toBe(200);
        expect((await otherTab.post("/auth/refresh")).status).toBe(200);
    });

    it("ends a sign-in 7 days after login, however often it is renewed", async () => {
        const { browser, user } = await signedIn();
        const [first] = await prisma.refreshToken.findMany({ where: { userId: user.id } });
        const days = (first.expiresAt.getTime() - first.createdAt.getTime()) / (24 * 60 * 60 * 1000);
        expect(days).toBeCloseTo(7, 1);

        const renewed = await browser.post("/auth/refresh");
        const cookie = renewed.headers["set-cookie"].find((c) => c.startsWith("refresh_token="));
        expect(new Date(cookie.match(/Expires=([^;]+)/)[1]).getTime()).toBeCloseTo(first.expiresAt.getTime(), -4);
        const latest = await prisma.refreshToken.findFirst({
            where: { userId: user.id },
            orderBy: { createdAt: "desc" },
        });
        expect(latest.expiresAt.getTime()).toBe(first.expiresAt.getTime());
    });

    it("keeps the session when a renewal's response never reached the browser", async () => {
        const { browser, user } = await signedIn();
        const cookies = browser.jar.getCookies({ domain: "127.0.0.1", path: "/auth", secure: false, script: false });
        const original = cookies.find((c) => c.name === "refresh_token").value;

        // The server renews, but the browser never gets the answer (e.g. the server restarted)
        const lost = request.agent(app);
        lost.jar.setCookie(`refresh_token=${original}; Path=/auth`, "127.0.0.1");
        expect((await lost.post("/auth/refresh")).status).toBe(200);
        // Long after the 30s grace window, the browser retries with the token it still has
        await prisma.refreshToken.updateMany({
            where: { userId: user.id, revokedAt: { not: null } },
            data: { revokedAt: new Date(Date.now() - 5 * 60 * 1000) },
        });

        expect((await browser.post("/auth/refresh")).status).toBe(200);
        expect((await browser.get("/profile")).status).toBe(200);
    });

    it("logout ends the session server side", async () => {
        const { browser, user } = await signedIn();
        expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(1);
        expect((await browser.post("/auth/logout")).status).toBe(200);
        expect(await prisma.refreshToken.count({ where: { userId: user.id } })).toBe(0);
        expect((await browser.get("/profile")).status).toBe(401);
    });

    it("accepts tokens signed with the previous secret during rotation only when it is configured", async () => {
        const user = await createUser();
        const oldToken = jwt.sign({ userId: user.id, tv: 0 }, "old-secret", { expiresIn: 60 });
        const res = await request(app).get("/profile").set("Cookie", `auth_token=${oldToken}`);
        expect(res.status).toBe(401);
    });
});

describe("password reset", () => {
    it("resets with the emailed code and ends other sessions", async () => {
        const { browser: oldBrowser, user } = await signedIn();

        await request(app).post("/auth/forgot-password").send({ email: user.email });
        const code = global.sentEmails.find((e) => e.kind === "password-reset").otp;

        const reset = await request(app)
            .post("/auth/reset-password")
            .send({ email: user.email, otp: code, newPassword: "N3w!password" });
        expect(reset.status).toBe(200);

        expect((await oldBrowser.get("/profile")).status).toBe(401);
        expect((await oldBrowser.post("/auth/refresh")).status).toBe(401);
        const login = await request(app).post("/login").send({ email: user.email, password: "N3w!password" });
        expect(login.status).toBe(200);
    });

    it("gives the same answer for unknown addresses", async () => {
        const res = await request(app).post("/auth/forgot-password").send({ email: "nobody@example.com" });
        expect(res.status).toBe(200);
        expect(global.sentEmails).toHaveLength(0);
    });
});
