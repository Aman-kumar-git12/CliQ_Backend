const { prisma } = require("../prisma/prismaClient");

async function test() {
    try {
        const count = await prisma.users.count();
        console.log("Total users:", count);
        
        const firstUser = await prisma.users.findFirst({
            select: { id: true, firstname: true, expertise: true }
        });
        console.log("First user sample:", JSON.stringify(firstUser, null, 2));

        const connectionsCount = await prisma.connectionsRequest.count();
        console.log("Total connection requests:", connectionsCount);
        
    } catch (e) {
        console.error("Test failed:", e);
    } finally {
        process.exit();
    }
}

test();
