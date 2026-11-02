// Shared test helpers: the app, the database, and signed-in browsers (supertest agents keep cookies).
const bcrypt = require("bcrypt");
const request = require("supertest");
const { createApp } = require("../../src/createApp");
const { prisma } = require("../../prisma/prismaClient");

const app = createApp();
const PASSWORD = "Str0ng!Pass";

let counter = 0;
const uniqueEmail = (prefix = "user") => `${prefix}-${Date.now()}-${++counter}@example.com`;

// A verified account straight in the database (skips the signup emails)
const createUser = async (overrides = {}) =>
    prisma.users.create({
        data: {
            firstname: "Test",
            lastname: "User",
            email: uniqueEmail(),
            age: 25,
            password: await bcrypt.hash(overrides.password || PASSWORD, 4),
            authProvider: "local",
            emailVerified: true,
            conversationsIds: [],
            ...overrides,
            ...(overrides.password ? { password: await bcrypt.hash(overrides.password, 4) } : {}),
        },
    });

// A browser signed in as a new (or the given) user
const signedIn = async (user) => {
    const account = user || (await createUser());
    const browser = request.agent(app);
    const res = await browser.post("/login").send({ email: account.email, password: PASSWORD });
    if (res.status !== 200) throw new Error(`Login failed in test setup: ${res.status} ${res.text}`);
    return { browser, user: account };
};

const cookieNames = (res) => (res.headers["set-cookie"] || []).map((cookie) => cookie.split("=")[0]);

const connect = (a, b) =>
    prisma.connectionsRequest.create({ data: { fromUserId: a.id, toUserId: b.id, status: "accepted" } });

afterAll(() => prisma.$disconnect());

module.exports = { app, prisma, request, PASSWORD, uniqueEmail, createUser, signedIn, cookieNames, connect };
