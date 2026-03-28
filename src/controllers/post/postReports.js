const { prisma } = require("../../../prisma/prismaClient");

const reportPost = async (req, res) => {
    try {
        const { postId } = req.params;
        const { reason } = req.body;
        const userId = req.user.id;

        if (!reason) return res.status(400).json({ message: "Reason is required to report a post" });

        const existingReport = await prisma.report.findFirst({ where: { userId, postId } });
        if (existingReport) return res.status(400).json({ message: "Already reported" });

        const report = await prisma.report.create({ data: { reason, postId, userId } });
        res.json({ message: "Post reported successfully", report });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

const reportComment = async (req, res) => {
    try {
        const { commentId } = req.params;
        const { reason } = req.body;
        const userId = req.user.id;

        if (!reason) return res.status(400).json({ message: "Reason is required to report a comment" });

        const existingReport = await prisma.report.findFirst({ where: { userId, commentId } });
        if (existingReport) return res.status(400).json({ message: "Already reported" });

        const report = await prisma.report.create({ data: { reason, commentId, userId } });
        res.json({ message: "Comment reported successfully", report });
    } catch (error) {
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

module.exports = { reportPost, reportComment };
