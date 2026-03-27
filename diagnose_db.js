const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
    try {
        const userCount = await prisma.users.count();
        console.log('Total Users:', userCount);
        
        const sessions = await prisma.users.findMany({ take: 5, select: { id: true, firstname: true } });
        console.log('Sample Users:', sessions);
        
        const userId = sessions[0]?.id; // Just pick the first one to test
        if (!userId) return;
        
        const connections = await prisma.connectionsRequest.findMany({
            where: { OR: [{ toUserId: userId }, { fromUserId: userId }] },
            select: { fromUserId: true, toUserId: true }
        });
        console.log(`User ${userId} has ${connections.length} connection requests.`);
        
        const preferences = await prisma.recommendationPreference.findMany({
            where: { userId: userId },
            select: { candidateUserId: true, status: true }
        });
        console.log(`User ${userId} has ${preferences.length} preferences:`, preferences.map(p => p.status));
        
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
