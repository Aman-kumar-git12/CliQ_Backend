const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  try {
    const userId = "69c6e00e151eac80a8ec39be";
    const events = await prisma.recommendationEvent.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 20
    });
    console.log(`Checking ${events.length} most recent events for ${userId}:`);
    events.forEach(e => {
      console.log(`- Action: ${e.action}, Source: ${e.source}, Candidate: ${e.candidateUserId}, CreatedAt: ${e.createdAt}`);
    });

    const sources = ["smart_connections", "saved_recommendations", "manual_toggle", "manual_request"];
    const actions = ["shown", "saved", "interested", "ignored"];
    
    const count = await prisma.recommendationEvent.count({
      where: {
        userId,
        source: { in: sources },
        action: { in: actions }
      }
    });
    console.log(`Dashboard-compatible event count: ${count}`);

  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

check();
