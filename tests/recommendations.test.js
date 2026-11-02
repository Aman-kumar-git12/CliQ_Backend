const { prisma, signedIn, createUser, connect } = require("./helpers/app");
const {
    recommendationCacheMemory,
    getRecommendationCacheKey,
    getRecommendationCachePayload,
    setCachedRecommendationBatch,
    invalidateRecommendationCache,
} = require("../src/utils/recommendations/caching");
const {
    warmRecommendationCacheForUser,
    refreshRecommendationCacheInBackground,
    backgroundRankings,
} = require("../src/utils/recommendations/matching");

// The client's connect() never settles while Redis is down (it keeps retrying), so every cache call would hang.
// A Redis that is never ready makes the hot copy live in recommendationCacheMemory instead.
jest.mock("../src/config/redisClient", () => ({ isReady: false, ensureReady: async () => false, on: () => {} }));

// Background ranking works like the real one (one per user at a time), but the tests can see when it is
// started and wait for it to finish. Login starts one too.
jest.mock("../src/utils/recommendations/matching", () => {
    const actual = jest.requireActual("../src/utils/recommendations/matching");
    const backgroundRankings = new Map();
    const refreshRecommendationCacheInBackground = jest.fn(({ userId }) => {
        if (!userId || backgroundRankings.has(userId)) return;
        const ranking = actual.warmRecommendationCacheForUser(userId).finally(() => backgroundRankings.delete(userId));
        backgroundRankings.set(userId, ranking);
    });
    return { ...actual, refreshRecommendationCacheInBackground, backgroundRankings };
});

const settleBackgroundRankings = async () => {
    while (backgroundRankings.size > 0) {
        await Promise.all(backgroundRankings.values());
    }
};

const RANKING_FIELDS = [
    "id",
    "matchScore",
    "matchConfidence",
    "profileQualityScore",
    "profileQualityLabel",
    "selectionMode",
    "diversity",
    "matchWarning",
    "matchReasons",
    "matchReason",
];

const VIEWER_EXPERTISE = {
    description: "Backend engineer building payment APIs with Node.js",
    skills: ["Node.js", "MongoDB", "System design"],
    interests: ["fintech", "open source"],
    experience: "4 years building payment services at a fintech startup",
    lookingFor: ["co-founder", "mentor"],
    details: { address: "Bengaluru, India" },
};

const CANDIDATE_PROFILES = [
    {
        firstname: "Asha",
        expertise: {
            description: "Full-stack developer shipping React and Node.js products",
            skills: ["React", "Node.js", "TypeScript"],
            interests: ["startups", "open source"],
            experience: "5 years at a SaaS company, leading the web team",
            details: { address: "Bengaluru, India" },
        },
    },
    {
        firstname: "Rohan",
        expertise: {
            description: "Data scientist working on credit risk models",
            skills: ["Python", "Machine learning", "SQL"],
            interests: ["fintech", "statistics"],
            experience: "3 years building scoring models for a lending platform",
            details: { address: "Mumbai, India" },
        },
    },
    {
        firstname: "Meera",
        expertise: {
            description: "Product designer focused on mobile banking apps",
            skills: ["Figma", "User research", "Prototyping"],
            interests: ["design systems", "fintech"],
            experience: "6 years designing consumer finance products",
            details: { address: "Pune, India" },
        },
    },
    {
        firstname: "Kabir",
        expertise: {
            description: "DevOps engineer running Kubernetes clusters at scale",
            skills: ["Kubernetes", "Terraform", "AWS"],
            interests: ["infrastructure", "open source"],
            experience: "4 years in site reliability engineering",
            details: { address: "Hyderabad, India" },
        },
    },
];

const LATE_CANDIDATE = {
    firstname: "Nisha",
    expertise: {
        description: "Mobile engineer building Android apps in Kotlin",
        skills: ["Kotlin", "Android", "Jetpack Compose"],
        interests: ["mobile", "accessibility"],
        experience: "3 years at a consumer app studio",
        details: { address: "Chennai, India" },
    },
};

// Every user made here is removed afterwards, so later tests rank only their own candidates
const createdUserIds = [];
const track = (user) => {
    createdUserIds.push(user.id);
    return user;
};
const createCandidate = async ({ firstname, expertise }) => track(await createUser({ firstname, expertise }));
const createCandidates = (profiles = CANDIDATE_PROFILES) => Promise.all(profiles.map(createCandidate));

const storedList = (userId) => prisma.recommendationList.findUnique({ where: { userId } });
const storedIds = (list) => list.items.map((item) => item.id);
const ids = (users) => users.map((user) => user.id);

// A signed-in user with no recommendations yet (the ranking started by login is finished and discarded)
const signedInViewer = async () => {
    const session = await signedIn(track(await createUser({ firstname: "Viewer", expertise: VIEWER_EXPERTISE })));
    await settleBackgroundRankings();
    await prisma.recommendationList.deleteMany({ where: { userId: session.user.id } });
    recommendationCacheMemory.clear();
    refreshRecommendationCacheInBackground.mockClear();
    return session;
};

// A ranked list in MongoDB with the hot copy cleared, as after a restart or a Redis expiry
const rankAndForgetHotCopy = async (userId) => {
    await warmRecommendationCacheForUser(userId);
    recommendationCacheMemory.clear();
    return storedList(userId);
};

// Recommendations rank everyone in the database, so this file starts without the users other test files
// left behind (new signups get placeholder expertise, which counts as discoverable)
beforeAll(async () => {
    await prisma.recommendationList.deleteMany({});
    await prisma.users.deleteMany({});
});

afterEach(async () => {
    await settleBackgroundRankings();
    recommendationCacheMemory.clear();
    refreshRecommendationCacheInBackground.mockClear();
    const userIds = createdUserIds.splice(0);
    await prisma.recommendationList.deleteMany({});
    await prisma.connectionsRequest.deleteMany({
        where: { OR: [{ fromUserId: { in: userIds } }, { toUserId: { in: userIds } }] },
    });
    await prisma.users.deleteMany({ where: { id: { in: userIds } } });
});

describe("Get Connections (smart users)", () => {
    it("returns seed picks at once on the first visit and stores the background ranking without profile data", async () => {
        const { browser, user } = await signedInViewer();
        const candidates = await createCandidates();

        const res = await browser.get("/request/smart-users");
        expect(res.status).toBe(200);
        expect(ids(res.body).sort()).toEqual(ids(candidates).sort());
        res.body.forEach((candidate) => expect(candidate.selectionMode).toBe("seed"));
        expect(refreshRecommendationCacheInBackground).toHaveBeenCalledWith({ userId: user.id });

        await settleBackgroundRankings();
        const list = await storedList(user.id);
        expect(list.strategy).toBe("fallback");
        expect(list.staleAt).toBeNull();
        expect(storedIds(list).sort()).toEqual(ids(candidates).sort());
        list.items.forEach((item) => {
            expect(Object.keys(item).sort()).toEqual([...RANKING_FIELDS].sort());
            expect(item).not.toHaveProperty("firstname");
            expect(item).not.toHaveProperty("expertise");
            expect(item).not.toHaveProperty("email");
        });
    });

    it("serves the stored list in ranked order with current profile data, without re-ranking", async () => {
        const { browser, user } = await signedInViewer();
        const candidates = await createCandidates();
        const list = await rankAndForgetHotCopy(user.id);
        // A profile edit after ranking shows up without re-ranking
        await prisma.users.update({ where: { id: candidates[0].id }, data: { firstname: "Asha Renamed" } });

        const res = await browser.get("/request/smart-users");
        expect(res.status).toBe(200);
        expect(ids(res.body)).toEqual(storedIds(list));
        res.body.forEach((candidate, index) => {
            expect(candidate.matchScore).toBe(list.items[index].matchScore);
            expect(candidate.firstname).toEqual(expect.any(String));
            expect(candidate.expertise.skills.length).toBeGreaterThan(0);
        });
        expect(res.body.find((candidate) => candidate.id === candidates[0].id).firstname).toBe("Asha Renamed");

        expect(refreshRecommendationCacheInBackground).not.toHaveBeenCalled();
        expect((await storedList(user.id)).computedAt).toEqual(list.computedAt);
    });

    it("keeps serving an invalidated list and re-ranks it in the background", async () => {
        const { browser, user } = await signedInViewer();
        await createCandidates();
        await warmRecommendationCacheForUser(user.id);
        const list = await storedList(user.id);

        await invalidateRecommendationCache(user.id);
        expect(recommendationCacheMemory.has(getRecommendationCacheKey(user.id))).toBe(false);
        const stale = await storedList(user.id);
        expect(stale.staleAt).toBeInstanceOf(Date);
        expect(stale.items).toEqual(list.items);

        const res = await browser.get("/request/smart-users");
        expect(res.status).toBe(200);
        expect(ids(res.body)).toEqual(storedIds(list));
        expect(refreshRecommendationCacheInBackground).toHaveBeenCalledWith({ userId: user.id });

        await settleBackgroundRankings();
        const refreshed = await storedList(user.id);
        expect(refreshed.staleAt).toBeNull();
        expect(refreshed.computedAt.getTime()).toBeGreaterThan(list.computedAt.getTime());
        expect(storedIds(refreshed).sort()).toEqual(storedIds(list).sort());
    });

    it("answers ?refresh=true from the stored list and re-ranks in the background", async () => {
        const { browser, user } = await signedInViewer();
        await createCandidates();
        const list = await rankAndForgetHotCopy(user.id);

        const res = await browser.get("/request/smart-users?refresh=true");
        expect(res.status).toBe(200);
        expect(ids(res.body)).toEqual(storedIds(list));
        res.body.forEach((candidate) => expect(candidate.selectionMode).not.toBe("seed"));
        expect(refreshRecommendationCacheInBackground).toHaveBeenCalledWith({ userId: user.id });

        await settleBackgroundRankings();
        const refreshed = await storedList(user.id);
        expect(refreshed.staleAt).toBeNull();
        expect(refreshed.computedAt.getTime()).toBeGreaterThan(list.computedAt.getTime());
    });

    it("drops users deleted since the list was ranked", async () => {
        const { browser, user } = await signedInViewer();
        const candidates = await createCandidates();
        const list = await rankAndForgetHotCopy(user.id);
        const deletedId = storedIds(list)[1];
        await prisma.users.delete({ where: { id: deletedId } });

        const res = await browser.get("/request/smart-users");
        expect(res.status).toBe(200);
        expect(ids(res.body)).toEqual(storedIds(list).filter((id) => id !== deletedId));
        expect(res.body).toHaveLength(candidates.length - 1);
    });

    it("shows quick seed picks when everyone in the list is excluded", async () => {
        const { browser, user } = await signedInViewer();
        const [connected, ...others] = await createCandidates(CANDIDATE_PROFILES.slice(0, 3));
        const list = await rankAndForgetHotCopy(user.id);
        // Joined after the list was ranked, so only the quick picks can show them
        const newcomer = await createCandidate(LATE_CANDIDATE);
        await connect(user, connected);

        const query = others.map((other) => `excludeIds=${other.id}`).join("&");
        const res = await browser.get(`/request/smart-users?${query}`);
        expect(res.status).toBe(200);
        expect(ids(res.body)).toEqual([newcomer.id]);
        expect(res.body[0]).toMatchObject({ firstname: "Nisha", selectionMode: "seed" });
        expect(refreshRecommendationCacheInBackground).toHaveBeenCalledWith({ userId: user.id });

        // The next list is ranked in the background without the new connection
        await settleBackgroundRankings();
        const refreshed = await storedList(user.id);
        expect(refreshed.computedAt.getTime()).toBeGreaterThan(list.computedAt.getTime());
        expect(storedIds(refreshed)).toContain(newcomer.id);
        expect(storedIds(refreshed)).not.toContain(connected.id);
    });

    it("never stores seed batches", async () => {
        const { browser, user } = await signedInViewer();
        const candidates = await createCandidates();
        // Keep the background ranking from running, so only the seed batch could have been saved
        refreshRecommendationCacheInBackground.mockImplementationOnce(() => {});

        const res = await browser.get("/request/smart-users");
        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThan(0);
        res.body.forEach((candidate) => expect(candidate.selectionMode).toBe("seed"));
        expect(refreshRecommendationCacheInBackground).toHaveBeenCalledTimes(1);
        expect(await storedList(user.id)).toBeNull();

        // The hot copy holds the seed batch; the database still does not
        expect(recommendationCacheMemory.get(getRecommendationCacheKey(user.id)).value.strategy).toBe("seed");
        await setCachedRecommendationBatch(user.id, getRecommendationCachePayload(candidates, "seed"));
        expect(await storedList(user.id)).toBeNull();
    });
});
