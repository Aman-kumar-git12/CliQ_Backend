const { prisma } = require("../../../prisma/prismaClient");
const {
    MAX_UNBLOCK_REQUESTS_PER_ACCOUNT,
    UNBLOCK_REQUEST_COOLDOWN_MS
} = require("./authHelpers");

const createUnblockRequest = async (req, res) => {
    try {
        const email = String(req.body?.email || "").trim().toLowerCase();
        const message = String(req.body?.message || "").trim();

        if (!message) {
            return res.status(400).json({ message: "Please explain why your account should be unblocked." });
        }

        if (!email) {
            return res.status(400).json({ message: "Please provide the blocked account email." });
        }

        const user = await prisma.users.findUnique({
            where: { email },
            select: { id: true, isBlocked: true },
        });

        if (!user) {
            return res.status(404).json({ message: "No account found with this email." });
        }

        if (!user.isBlocked) {
            return res.status(400).json({ message: "This account is not blocked, so an unblock request is not needed." });
        }

        const [requestCount, latestRequest] = await Promise.all([
            prisma.unblockRequest.count({
                where: { userId: user.id },
            }),
            prisma.unblockRequest.findFirst({
                where: { userId: user.id },
                orderBy: { createdAt: "desc" },
                select: { id: true, createdAt: true },
            }),
        ]);

        if (requestCount >= MAX_UNBLOCK_REQUESTS_PER_ACCOUNT) {
            return res.status(429).json({
                message: `You have reached the maximum of ${MAX_UNBLOCK_REQUESTS_PER_ACCOUNT} unblock requests for this account.`,
            });
        }

        if (latestRequest) {
            const nextAllowedTime = new Date(latestRequest.createdAt).getTime() + UNBLOCK_REQUEST_COOLDOWN_MS;
            const remainingMs = nextAllowedTime - Date.now();

            if (remainingMs > 0) {
                const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
                return res.status(429).json({
                    message: `You can send your next unblock request after ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}.`,
                });
            }
        }

        const request = await prisma.unblockRequest.create({
            data: {
                userId: user.id,
                message,
                status: "pending",
            },
        });

        return res.status(201).json({
            message: "Your unblock request has been submitted.",
            request,
        });
    } catch (err) {
        return res.status(500).json({
            message: "Internal server error",
            error: err.message
        });
    }
};

module.exports = { createUnblockRequest };
