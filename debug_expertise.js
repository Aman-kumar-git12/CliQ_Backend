const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient({
    datasources: {
        db: {
            url: "mongodb+srv://Amankumar:a1m2a3n46201@cluster0.qmykjtu.mongodb.net/website_db?retryWrites=true&w=majority"
        }
    }
});

async function main() {
    try {
        const users = await prisma.users.findMany({
            select: { id: true, firstname: true, expertise: true }
        });
        
        console.log(`Analyzing ${users.length} users...`);
        
        users.forEach(u => {
            const exp = u.expertise || {};
            const skills = exp.skills || [];
            const interests = exp.interests || [];
            const desc = exp.description || "";
            const about = exp.aboutYou || "";
            
            console.log(`- ${u.firstname} (${u.id}): Skills=${Array.isArray(skills) ? skills.length : '?'}, Interests=${Array.isArray(interests) ? interests.length : '?'}, DescLen=${desc.length}, AboutLen=${about.length}`);
        });
        
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
