const nodemailer = require("nodemailer");
const { buildEmailVerificationUrl } = require("./emailVerificationUtils");

let transporterCache = null;

const getMailTransporter = () => {
    if (transporterCache) {
        return transporterCache;
    }

    const {
        SMTP_HOST,
        SMTP_PORT,
        SMTP_USER,
        SMTP_PASS,
        SMTP_SECURE,
    } = process.env;

    if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
        throw new Error("SMTP configuration is incomplete. Please set SMTP_HOST, SMTP_PORT, SMTP_USER, and SMTP_PASS.");
    }

    const isGmail = SMTP_HOST.includes("gmail.com");

    const config = isGmail 
        ? {
            service: 'gmail',
            auth: {
                user: SMTP_USER,
                pass: SMTP_PASS,
            }
        } 
        : {
            host: SMTP_HOST,
            port: Number(SMTP_PORT),
            secure: String(SMTP_SECURE || "").toLowerCase() === "true" || Number(SMTP_PORT) === 465,
            auth: {
                user: SMTP_USER,
                pass: SMTP_PASS,
            },
            tls: {
                rejectUnauthorized: false
            }
        };

    transporterCache = nodemailer.createTransport(config);

    return transporterCache;
};

// ── Legacy token-link email (kept for backward compat) ───────────────────────
const sendVerificationEmail = async ({ email, firstname, token }) => {
    const verificationUrl = buildEmailVerificationUrl(token);
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    if (!from) {
        throw new Error("SMTP_FROM or SMTP_USER must be configured before sending verification emails.");
    }

    const transporter = getMailTransporter();

    await transporter.sendMail({
        from,
        to: email,
        subject: "Verify your email address",
        text: [
            `Hi ${firstname || "there"},`,
            "",
            "Please verify your email address by clicking the link below:",
            verificationUrl,
            "",
            "This link will expire in 1 hour.",
        ].join("\n"),
        html: `
            <p>Hi ${firstname || "there"},</p>
            <p>Please verify your email address by clicking the link below:</p>
            <p><a href="${verificationUrl}">${verificationUrl}</a></p>
            <p>This link will expire in 1 hour.</p>
        `,
    });

    return verificationUrl;
};

// ── OTP email ─────────────────────────────────────────────────────────────────
const sendOTPEmail = async ({ email, firstname, otp }) => {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    if (!from) {
        throw new Error("SMTP_FROM or SMTP_USER must be configured before sending OTP emails.");
    }

    const transporter = getMailTransporter();

    // Render each digit in its own box for clarity
    const digitBoxes = otp
        .split("")
        .map(
            (d) =>
                `<span style="display:inline-block;width:44px;height:52px;line-height:52px;text-align:center;font-size:28px;font-weight:700;letter-spacing:0;background:#1a1a1a;color:#ffffff;border:2px solid #333333;border-radius:10px;margin:0 4px;">${d}</span>`
        )
        .join("");

    const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width:480px;background:#0d0d0d;border-radius:20px;border:1px solid #222;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="padding:36px 40px 24px;text-align:center;border-bottom:1px solid #1a1a1a;">
              <p style="margin:0;font-size:13px;letter-spacing:0.15em;text-transform:uppercase;color:#666;">Email Verification</p>
              <h1 style="margin:10px 0 0;font-size:26px;font-weight:700;color:#ffffff;">Your one-time code</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 8px;font-size:15px;color:#aaaaaa;">Hi <strong style="color:#ffffff;">${firstname || "there"}</strong>,</p>
              <p style="margin:0 0 32px;font-size:15px;color:#888888;line-height:1.6;">
                Use the code below to verify your email address. It expires in <strong style="color:#ffffff;">10 minutes</strong>.
              </p>

              <!-- OTP Boxes -->
              <div style="text-align:center;margin:0 0 36px;">
                ${digitBoxes}
              </div>

              <p style="margin:0;font-size:13px;color:#555555;text-align:center;">
                If you didn't create an account, you can safely ignore this email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:20px 40px;text-align:center;border-top:1px solid #1a1a1a;">
              <p style="margin:0;font-size:12px;color:#444444;">This code is valid for 10 minutes only.</p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const text = [
        `Hi ${firstname || "there"},`,
        "",
        `Your verification code is: ${otp}`,
        "",
        "This code expires in 10 minutes.",
        "If you didn't create an account, ignore this email.",
    ].join("\n");

    await transporter.sendMail({
        from,
        to: email,
        subject: `${otp} is your verification code`,
        text,
        html,
    });
};

// ── Password Reset OTP Email ──────────────────────────────────────────────────
const sendPasswordResetEmail = async ({ email, firstname, otp }) => {
    const from = process.env.SMTP_FROM || process.env.SMTP_USER;

    if (!from) {
        throw new Error("SMTP_FROM or SMTP_USER must be configured before sending emails.");
    }

    const transporter = getMailTransporter();

    // Render each digit in its own box
    const digitBoxes = otp
        .split("")
        .map(
            (d) =>
                `<span style="display:inline-block;width:44px;height:52px;line-height:52px;text-align:center;font-size:28px;font-weight:700;letter-spacing:0;background:#1a1a1a;color:#ffffff;border:2px solid #333333;border-radius:10px;margin:0 4px;">${d}</span>`
        )
        .join("");

    const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#000000;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#000000;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" style="max-width:480px;background:#0d0d0d;border-radius:20px;border:1px solid #222;overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="padding:36px 40px 24px;text-align:center;border-bottom:1px solid #1a1a1a;">
              <p style="margin:0;font-size:13px;letter-spacing:0.15em;text-transform:uppercase;color:#666;">Security Alert</p>
              <h1 style="margin:10px 0 0;font-size:26px;font-weight:700;color:#ffffff;">Password Reset Request</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 40px;">
              <p style="margin:0 0 8px;font-size:15px;color:#aaaaaa;">Hi <strong style="color:#ffffff;">${firstname || "there"}</strong>,</p>
              <p style="margin:0 0 32px;font-size:15px;color:#888888;line-height:1.6;">
                We received a request to reset your password. Use the code below to securely verify your identity. It expires in <strong style="color:#ffffff;">10 minutes</strong>.
              </p>

              <!-- OTP Boxes -->
              <div style="text-align:center;margin:0 0 36px;">
                ${digitBoxes}
              </div>

              <p style="margin:0;font-size:13px;color:#555555;text-align:center;">
                If you didn't request a password reset, you can safely completely ignore this email. Your account remains secure.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const text = [
        `Hi ${firstname || "there"},`,
        "",
        "We received a request to reset your password.",
        "",
        `Your password reset code is: ${otp}`,
        "",
        "This code expires in 10 minutes.",
        "If you didn't request a password reset, ignore this email.",
    ].join("\n");

    await transporter.sendMail({
        from,
        to: email,
        subject: `${otp} is your password reset code`,
        text,
        html,
    });
};

module.exports = {
    sendVerificationEmail,
    sendOTPEmail,
    sendPasswordResetEmail,
};
