const { PrismaClient } = require('@prisma/client');
const { prepareSmartRecommendationContext } = require('./src/utils/recommendations/matching');
const { buildRankedRecommendationBatch } = require('./src/utils/recommendations/ranking');
const { buildFallbackRankings } = require('./src/utils/recommendations/scoring');
const { RECOMMENDATION_PREVIEW_SELECT } = require('./src/utils/recommendations/constants');
const prisma = new PrismaClient();

async function check() {
    try {
        const userId = '69c86c4672f2df9fe806cb45'; // User ID from previous check
        console.log('--- STARTING DIAGNOSTIC ---');
        console.log('USER ID:', userId);

        const context = await prepareSmartRecommendationContext(userId);
        console.log('ELIGIBLE COUNT:', context.eligibleCandidates.length);

        if (context.eligibleCandidates.length === 0) {
            console.log('NO ELIGIBLE CANDIDATES IN CONTEXT');
            process.exit(0);
        }

        const fallbackRankings = buildFallbackRankings({ expertise: {} }, context.eligibleCandidates);
        console.log('FALLBACK RANKINGS COUNT:', fallbackRankings.length);

        let responseUsers = buildRankedRecommendationBatch({
            candidates: context.eligibleCandidates,
            fallbackRankings,
            rankedResults: [],
            feedbackProfile: null,
            userExpertise: {},
            limit: 5
        });

        console.log('FINAL SMART RESPONSE COUNT:', responseUsers.length);
        
        if (responseUsers.length === 0) {
            console.log('EMERGENCY FALLBACK SIMULATION START');
            const allCandidates = await prisma.users.findMany({
                where: { id: { notIn: [userId] } },
                take: 10,
                select: RECOMMENDATION_PREVIEW_SELECT
            });
            console.log('TOTAL OTHERS IN DB:', allCandidates.length);
        } else {
            console.log('FIRST USER DATA:', JSON.stringify(responseUsers[0], null, 2));
        }

        process.exit(0);
    } catch (err) {
        console.error('DIAGNOSTIC FAILED:', err);
        process.exit(1);
    }
}

check();
