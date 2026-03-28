const buildRecommendationAnalyticsSnapshot = (events = [], label = "personal") => {
    const summary = summarizeRecommendationHistory(events);
    const sourceBreakdown = new Map();
    const deliveryBreakdown = new Map();
    const confidenceBreakdown = new Map();
    const profileQualityBreakdown = new Map();
    const selectionModeBreakdown = new Map();
    const clusterBreakdown = new Map();
    const profileTypeBreakdown = new Map();
    const locationBreakdown = new Map();
    const backgroundBreakdown = new Map();
    const uniqueCandidates = new Set();

    events.forEach((event) => {
        uniqueCandidates.add(event.candidateUserId);
        incrementBucket(sourceBreakdown, event.source || "unknown");
        incrementBucket(deliveryBreakdown, event.metadata?.delivery || "untracked");
        incrementBucket(confidenceBreakdown, event.metadata?.matchConfidence || "unknown");
        incrementBucket(profileQualityBreakdown, event.metadata?.profileQualityLabel || "unknown");
        incrementBucket(selectionModeBreakdown, event.metadata?.selectionMode || "unknown");
        incrementBucket(clusterBreakdown, event.metadata?.diversity?.clusterKey || "cluster:unknown");
        incrementBucket(profileTypeBreakdown, event.metadata?.diversity?.profileType || "generalist");
        incrementBucket(locationBreakdown, event.metadata?.diversity?.locationBucket || "location:unknown");
        incrementBucket(backgroundBreakdown, event.metadata?.diversity?.backgroundKey || "background:unknown");
    });

    return {
        label,
        counts: summary.counts,
        conversion: summary.conversion,
        uniqueCandidates: uniqueCandidates.size,
        sourceBreakdown: mapToSortedObject(sourceBreakdown),
        deliveryBreakdown: mapToSortedObject(deliveryBreakdown),
        confidenceBreakdown: mapToSortedObject(confidenceBreakdown),
        profileQualityBreakdown: mapToSortedObject(profileQualityBreakdown),
        selectionModeBreakdown: mapToSortedObject(selectionModeBreakdown),
        diversityBreakdown: {
            clusters: mapToSortedObject(clusterBreakdown, 8),
            profileTypes: mapToSortedObject(profileTypeBreakdown, 8),
            locations: mapToSortedObject(locationBreakdown, 8),
            backgrounds: mapToSortedObject(backgroundBreakdown, 8),
        },
        trend: buildActionTrend(events, 14),
        funnel: {
            shown: summary.counts.shown || 0,
            saved: summary.counts.saved || 0,
            ignored: summary.counts.ignored || 0,
            interested: summary.counts.interested || 0,
        },
    };
};

// ... and the helpers
const summarizeRecommendationHistory = (events = []) => {
    const counts = { shown: 0, saved: 0, ignored: 0, interested: 0 };
    events.forEach((event) => {
        if (counts[event.action] !== undefined) counts[event.action]++;
    });
    const shown = counts.shown || 0;
    return {
        counts,
        conversion: {
            interestRate: shown > 0 ? Number((counts.interested / shown).toFixed(3)) : 0,
            saveRate: shown > 0 ? Number((counts.saved / shown).toFixed(3)) : 0,
        },
    };
};

const incrementBucket = (map, key, amount = 1) => {
    if (!key) return;
    map.set(key, (map.get(key) || 0) + amount);
};

const mapToSortedObject = (map, limit = null) => {
    const entries = [...map.entries()].sort((left, right) => right[1] - left[1]);
    const sliced = Number.isFinite(limit) ? entries.slice(0, limit) : entries;
    return Object.fromEntries(sliced);
};

const buildActionTrend = (events = [], days = 14) => {
    const today = new Date();
    const buckets = new Map();
    for (let index = days - 1; index >= 0; index -= 1) {
        const day = new Date(today);
        day.setHours(0, 0, 0, 0); day.setDate(day.getDate() - index);
        const key = day.toISOString().slice(0, 10);
        buckets.set(key, { shown: 0, saved: 0, ignored: 0, interested: 0 });
    }
    events.forEach((event) => {
        const key = new Date(event.createdAt).toISOString().slice(0, 10);
        const bucket = buckets.get(key);
        if (!bucket) return;
        bucket[event.action] = (bucket[event.action] || 0) + 1;
    });
    return [...buckets.entries()].map(([date, values]) => ({ date, ...values }));
};

module.exports = {
    summarizeRecommendationHistory,
    incrementBucket,
    mapToSortedObject,
    buildActionTrend,
    buildRecommendationAnalyticsSnapshot,
};
