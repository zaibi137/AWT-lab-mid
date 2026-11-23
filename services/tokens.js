/**
 * services/tokens.js — HMAC-based token signing and verification.
 * Tokens are compact: prefix.base64url(payload).signature
 * No external dependencies — uses Node's built-in crypto module.
 * Admin and participant tokens use different secrets/prefixes/expiry.
 */

const crypto = require("crypto");

const SECRET = process.env.TOKEN_SECRET || "dev-secret-change-me";

const ADMIN_SECRET  = SECRET + ":admin";
const PORTAL_SECRET = SECRET + ":participant";
const ADMIN_TTL_MS  = 8 * 60 * 60 * 1000;   // 8 hours
const PORTAL_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours

/** Encode an object as URL-safe base64. */
function encode(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

/** Decode a URL-safe base64 string to an object. Returns null on failure. */
function decode(str) {
  try { return JSON.parse(Buffer.from(str, "base64url").toString("utf8")); }
  catch { return null; }
}

/** Create an HMAC-SHA256 signature over `data` using `secret`. */
function hmac(secret, data) {
  return crypto.createHmac("sha256", secret).update(data).digest("base64url");
}

function sign(secret, payload) {
  const p = encode(payload);
  return `${p}.${hmac(secret, p)}`;
}

function verify(secret, token) {
  if (!token || typeof token !== "string") return null;
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const p   = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  // Constant-time comparison to prevent timing attacks.
  const expected = hmac(secret, p);
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = decode(p);
  if (!payload || payload.exp < Date.now()) return null;
  return payload;
}

/** Issue an admin token. Payload: { sub: "admin", exp }. */
function signAdminToken() {
  return sign(ADMIN_SECRET, { sub: "admin", exp: Date.now() + ADMIN_TTL_MS, iat: Date.now() });
}

function verifyAdminToken(token) {
  return verify(ADMIN_SECRET, token);
}

/**
 * Issue a participant token.
 * Payload: { sub: registrationId, exp }.
 */
function signParticipantToken(registrationId) {
  return sign(PORTAL_SECRET, { sub: registrationId, exp: Date.now() + PORTAL_TTL_MS, iat: Date.now() });
}

function verifyParticipantToken(token) {
  return verify(PORTAL_SECRET, token);
}

module.exports = { signAdminToken, verifyAdminToken, signParticipantToken, verifyParticipantToken };
