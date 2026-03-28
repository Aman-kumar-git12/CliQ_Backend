const { normalizeText } = require("./coreUtils");

const detectExperienceLevel = (expertise = {}, signals = {}) => {
    const source = [
        normalizeText(expertise.experienceLevel),
        normalizeText(expertise.yearsOfExperience),
        normalizeText(expertise.experience),
        signals.headline,
        ...(signals.textFields || []),
    ].join(" ").toLowerCase();

    if (!source) return "experience:unknown";
    if (source.includes("student") || source.includes("intern")) return "experience:student";
    if (source.includes("senior") || source.includes("lead") || source.includes("principal") || source.includes("10+") || source.includes("8+")) return "experience:senior";
    if (source.includes("junior") || source.includes("entry")) return "experience:junior";
    if (source.includes("mid") || source.includes("3+") || source.includes("4+")) return "experience:mid";
    return "experience:general";
};

const detectProfileType = (signals = {}) => {
    const text = [signals.headline, ...(signals.textFields || [])].join(" ").toLowerCase();
    if (text.includes("designer") || text.includes("ui/ux") || text.includes("ux ")) return "design";
    if (text.includes("manager") || text.includes("lead") || text.includes("strategy")) return "leadership";
    if (text.includes("data") || text.includes("analyst") || text.includes("analytics")) return "data";
    if (text.includes("devops") || text.includes("platform") || text.includes("cloud")) return "platform";
    if (text.includes("developer") || text.includes("engineer") || text.includes("software")) return "engineering";
    if ((signals.skills || []).length > 0) return signals.skills[0].toLowerCase();
    if ((signals.interests || []).length > 0) return signals.interests[0].toLowerCase();
    return "generalist";
};

const detectLocationBucket = (expertise = {}, signals = {}) => {
    const rawLocation = normalizeText(expertise?.details?.address || signals.textFields?.[0] || "");
    if (!rawLocation) return "location:unknown";
    const parts = rawLocation
        .split(/[,/|-]+/)
        .map((part) => normalizeText(part).toLowerCase())
        .filter(Boolean);
    if (parts.length === 0) return "location:unknown";
    return `location:${parts[parts.length - 1]}`;
};

const detectBackgroundKey = (signals = {}) => {
    const source = [signals.headline, ...(signals.textFields || [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
    if (!source) return "background:general";
    if (source.includes("startup") || source.includes("founder")) return "background:startup";
    if (source.includes("enterprise") || source.includes("consult")) return "background:enterprise";
    if (source.includes("student") || source.includes("college") || source.includes("university")) return "background:student";
    if (source.includes("freelance") || source.includes("agency")) return "background:freelance";
    if (source.includes("open source") || source.includes("community")) return "background:community";
    const token = [...(signals.tokens || [])][0];
    return token ? `background:${token}` : "background:general";
};

const getClusterKey = (signals = {}) => {
    if ((signals.skills || []).length > 0) return `skill:${signals.skills[0].toLowerCase()}`;
    if ((signals.interests || []).length > 0) return `interest:${signals.interests[0].toLowerCase()}`;
    if (signals.headline) return `headline:${signals.headline.toLowerCase().split(/\s+/).slice(0, 2).join("-")}`;
    return "cluster:general";
};

module.exports = {
    detectExperienceLevel,
    detectProfileType,
    detectLocationBucket,
    detectBackgroundKey,
    getClusterKey,
};
