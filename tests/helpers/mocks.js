// Emails are captured instead of sent; tests read the codes from sentEmails.
const sentEmails = [];
global.sentEmails = sentEmails;

jest.mock("../../src/utils/auth/mailUtils", () => {
    const record = (kind) => async (email) => {
        global.sentEmails.push({ kind, ...email });
    };
    return {
        sendVerificationEmail: record("verification-link"),
        sendOTPEmail: record("otp"),
        sendPasswordResetEmail: record("password-reset"),
    };
});

beforeEach(() => {
    sentEmails.length = 0;
});
