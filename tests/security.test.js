// Rate limits are on in this file only (the other files turn them off to send many requests)
process.env.RATE_LIMIT_ENABLED = "true";
process.env.RATE_LIMIT_AUTH_MAX = "5";
process.env.RATE_LIMIT_PER_EMAIL_MAX = "3";

const { app, request, createUser, PASSWORD } = require("./helpers/app");

describe("cross-site request protection", () => {
    it("refuses a changing request from another website's origin", async () => {
        const res = await request(app).post("/logout").set("Origin", "https://evil.example");
        expect(res.status).toBe(403);
        expect(res.body.code).toBe("BAD_ORIGIN");
    });

    it("allows the frontend's origin and requests without an Origin header", async () => {
        expect((await request(app).post("/logout").set("Origin", "http://localhost:5173")).status).toBe(200);
        expect((await request(app).post("/logout")).status).toBe(200);
    });

    it("never blocks reads", async () => {
        const res = await request(app).get("/api/health").set("Origin", "https://evil.example");
        expect(res.status).toBe(200);
    });
});

describe("rate limits", () => {
    it("limits attempts on one email address, whatever the IP", async () => {
        const user = await createUser();
        const attempt = () => request(app).post("/login").send({ email: user.email, password: "Wrong!pass1" });
        for (let i = 0; i < 3; i += 1) expect((await attempt()).status).toBe(401);
        const blocked = await attempt();
        expect(blocked.status).toBe(429);
        expect(blocked.body.code).toBe("RATE_LIMITED");
        // Even the right password waits until the window passes
        const right = await request(app).post("/login").send({ email: user.email, password: PASSWORD });
        expect(right.status).toBe(429);
    });

    it("limits auth requests per IP across different addresses", async () => {
        const responses = [];
        for (let i = 0; i < 4; i += 1) {
            responses.push(
                await request(app)
                    .post("/auth/forgot-password")
                    .send({ email: `nobody-${i}@example.com` }),
            );
        }
        // 3 logins above + these: the 5-per-IP auth limit is crossed
        expect(responses.map((res) => res.status)).toContain(429);
    });
});
