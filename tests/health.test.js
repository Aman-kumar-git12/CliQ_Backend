const { app, request } = require("./helpers/app");

describe("health, docs and errors", () => {
    it("answers the shallow and deep health checks", async () => {
        expect((await request(app).get("/api/health")).text).toBe("OK");
        const ready = await request(app).get("/api/health/ready");
        expect(ready.status).toBe(200);
        expect(ready.body).toMatchObject({ status: "ok", database: "ok" });
    });

    it("serves an OpenAPI document covering the routes", async () => {
        const res = await request(app).get("/api/docs/openapi.json");
        expect(res.status).toBe(200);
        expect(res.body.openapi).toBe("3.1.0");
        expect(Object.keys(res.body.paths).length).toBeGreaterThan(90);
        expect(res.body.paths["/login"].post.requestBody).toBeDefined();
        expect(res.body.paths["/profile"].get.security).toEqual([{ cookieAuth: [] }]);
    });

    it("gives unknown routes a JSON 404 and every response a request id", async () => {
        const res = await request(app).get("/no/such/route");
        expect(res.status).toBe(404);
        expect(res.body.message).toMatch(/Route not found/);
        expect(res.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("reuses a well-formed incoming request id and replaces a malformed one", async () => {
        const kept = await request(app).get("/api/health/ready").set("X-Request-Id", "abc12345-from-proxy");
        expect(kept.headers["x-request-id"]).toBe("abc12345-from-proxy");
        const replaced = await request(app).get("/api/health/ready").set("X-Request-Id", "bad id; with spaces");
        expect(replaced.headers["x-request-id"]).not.toContain("bad");
    });

    it("rejects malformed JSON with a 400", async () => {
        const res = await request(app).post("/login").set("Content-Type", "application/json").send("{bad json");
        expect(res.status).toBe(400);
    });
});
