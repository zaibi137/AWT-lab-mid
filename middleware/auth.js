/**
 * middleware/auth.js — Authentication middleware for admin and participant routes.
 * Both read the HMAC token from the Authorization: Bearer header.
 */

const { verifyAdminToken, verifyParticipantToken } = require("../services/tokens");

/** Protect an admin route. Returns 401 if token is missing or expired. */
function requireAdmin(req, res, next) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const payload = verifyAdminToken(token);
  if (!payload) return res.status(401).json({ error: "Please log in again." });
  req.admin = payload;
  next();
}

/** Protect a participant route. Sets req.participant = { registrationId: "VS-0001" }. */
function requireParticipant(req, res, next) {
  const token = (req.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const payload = verifyParticipantToken(token);
  if (!payload) return res.status(401).json({ error: "Session expired. Please log in again." });
  req.participant = { registrationId: payload.sub };
  next();
}

module.exports = { requireAdmin, requireParticipant };
