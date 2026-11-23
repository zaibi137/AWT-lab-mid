/**
 * services/mailer.js — Optional email notifications via nodemailer.
 * Sends emails only when all SMTP env vars are configured.
 * Any failure is caught and logged — it must never break the calling request.
 */

const nodemailer = require("nodemailer");

const SMTP_CONFIGURED =
  process.env.SMTP_HOST &&
  process.env.SMTP_USER &&
  process.env.SMTP_PASS &&
  process.env.MAIL_FROM;

/** Returns a reusable transporter, or null if SMTP is not configured. */
function getTransporter() {
  if (!SMTP_CONFIGURED) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
}

/** Send an email. Never throws — errors are logged. */
async function send(to, subject, html) {
  const transporter = getTransporter();
  if (!transporter) return; // SMTP not configured — skip silently.
  try {
    await transporter.sendMail({ from: process.env.MAIL_FROM, to, subject, html });
  } catch (err) {
    console.error("[mailer] Failed to send email:", err.message);
  }
}

/** Notify a team that their registration has been accepted. */
async function sendAccepted(reg, venue) {
  const memberNames = reg.members.map(m => m.name).join(" &amp; ");
  const venueHtml = venue ? `<p><strong>Venue:</strong> ${venue}</p>` : "";
  await send(
    reg.email,
    "VSPARK 2025 — Registration Accepted ✅",
    `<p>Dear ${memberNames},</p>
     <p>Your team <strong>${reg.teamName || "Solo"}</strong> (ID: <strong>${reg.id}</strong>) has been <strong>accepted</strong> for the VSPARK Prompt Engineering Competition.</p>
     ${venueHtml}
     <p>Log in to your participant portal with Registration ID <strong>${reg.id}</strong> when the competition opens to start your 20-minute window.</p>
     <p>Good luck!<br/>VSPARK Organizing Committee<br/>COMSATS University Islamabad, Vehari Campus</p>`
  );
}

/** Notify a team that their registration has been rejected. */
async function sendRejected(reg, reason) {
  const memberNames = reg.members.map(m => m.name).join(" &amp; ");
  const reasonHtml = reason ? `<p><strong>Reason:</strong> ${reason}</p>` : "";
  await send(
    reg.email,
    "VSPARK 2025 — Registration Status Update",
    `<p>Dear ${memberNames},</p>
     <p>Unfortunately, your team <strong>${reg.teamName || "Solo"}</strong> (ID: <strong>${reg.id}</strong>) could not be accepted at this time.</p>
     ${reasonHtml}
     <p>Please contact the organizers if you have questions.</p>
     <p>VSPARK Organizing Committee<br/>COMSATS University Islamabad, Vehari Campus</p>`
  );
}

module.exports = { sendAccepted, sendRejected };
