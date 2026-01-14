const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        // Fetch a user to simulate "currentUserId"
        const user = await prisma.users.findFirst();
        const currentUserId = user ? user.id : "000000000000000000000000";

        console.log("Testing with User ID:", currentUserId);

        // Test Case 1: Simple Match
        console.log("1. Testing simple $match on userId...");
        try {
            const res1 = await prisma.post.aggregateRaw({
                pipeline: [
                    { $match: { userId: { $ne: { "$oid": currentUserId } } } },
                    { $limit: 1 }
                ]
            });
            console.log("   Success:", res1);
        } catch (e) {
            console.error("   Failed:", e.message);
        }

        // Test Case 2: Full Pipeline
        console.log("\n2. Testing full pipeline...");
        const excludeIds = [];
        try {
            const res2 = await prisma.post.aggregateRaw({
                pipeline: [
                    {
                        $match: {
                            userId: { $ne: { "$oid": currentUserId } },
                            _id: { $nin: excludeIds.map(id => ({ "$oid": id })) }
                        }
                    },
                    { $sample: { size: 5 } },
                    { $project: { _id: 1 } }
                ]
            });
            console.log("   Success:", res2);
        } catch (e) {
            console.error("   Failed full pipeline:", e.message);
            // console.error(e);
        }

    } catch (error) {
        console.error("Global Error:", error);
    } finally {
        await prisma.$disconnect();
    }
}

main();
