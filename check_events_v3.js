const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  try {
    const userId = "69c6e00e151eac80a8ec39be";
    const interestedCount = await prisma.connectionsRequest.count({
      where: { fromUserId: userId, status: "interested" }
    });
    console.log(`Interested connections: ${interestedCount}`);
    
    // Check current time and recent events again
    const now = new Date();
    const recentShown = await prisma.recommendationEvent.count({
      where: { userId, action: "shown" }
    });
    console.log(`Total shown events in DB: ${recentShown}`);

  } catch (err) {
    console.error(err);
  } finally {
    await prisma.$disconnect();
  }
}

check();
