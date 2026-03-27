const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// Simulation of logic from requestController.js
const isMeaningfulText = (text) => typeof text === 'string' && text.trim().length > 3;
const normalizeTerms = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(t => typeof t === 'string' && t.trim().length > 0);
    if (typeof value === 'string') return value.split(',').map(s => s.trim()).filter(Boolean);
    return [];
};

const buildProfileSignals = (expertise = {}) => {
    const skills = normalizeTerms(expertise.skills);
    const interests = normalizeTerms(expertise.interests);
    const headline = isMeaningfulText(expertise.description) ? expertise.description : 
                     isMeaningfulText(expertise.aboutYou) ? expertise.aboutYou : "";
    const textFields = [expertise.description, expertise.aboutYou].filter(isMeaningfulText);
    
    return {
        skills,
        interests,
        headline,
        textFields,
        completeness: [headline, ...skills, ...interests, ...textFields].length,
    };
};

const isDiscoverableProfile = (expertise = {}) => {
    const signals = buildProfileSignals(expertise);
    const hasCoreSignal = Boolean(signals.headline) || signals.skills.length > 0 || signals.interests.length > 0;
    return hasCoreSignal && signals.completeness >= 1;
};

async function main() {
    try {
        const users = await prisma.users.findMany({
            select: { id: true, firstname: true, expertise: true }
        });
        
        console.log(`Checking ${users.length} users...`);
        
        let discoverableCount = 0;
        users.forEach(u => {
            const disc = isDiscoverableProfile(u.expertise || {});
            if (disc) discoverableCount++;
            // console.log(`User ${u.id} (${u.firstname}): Discoverable=${disc}`);
        });
        
        console.log(`Discoverable Users: ${discoverableCount}/${users.length}`);
        
        const sessions = await prisma.users.findMany({ take: 1, select: { id: true } });
        const loggedInUserId = sessions[0]?.id;
        
        if (loggedInUserId) {
            const connections = await prisma.connectionsRequest.findMany({
                where: { OR: [{ toUserId: loggedInUserId }, { fromUserId: loggedInUserId }] },
                select: { fromUserId: true, toUserId: true }
            });
            const excludedIds = new Set([loggedInUserId]);
            connections.forEach(c => { excludedIds.add(c.toUserId); excludedIds.add(c.fromUserId); });
            
            const ignoredPreferences = await prisma.recommendationPreference.findMany({
                where: { userId: loggedInUserId, status: "not_preferred" },
                select: { candidateUserId: true }
            });
            const ignoredIds = ignoredPreferences.map(p => p.candidateUserId);
            
            const finalExcluded = [...new Set([...Array.from(excludedIds), ...ignoredIds])];
            console.log(`Excluding ${finalExcluded.length} IDs for user ${loggedInUserId}`);
            
            const candidates = await prisma.users.findMany({
                where: { id: { notIn: finalExcluded } }
            });
            
            console.log(`Eligible for findMany: ${candidates.length}`);
            const eligible = candidates.filter(c => isDiscoverableProfile(c.expertise || {}));
            console.log(`Eligible after discoverable filter: ${eligible.length}`);
        }
        
    } catch (e) {
        console.error(e);
    } finally {
        await prisma.$disconnect();
    }
}

main();
