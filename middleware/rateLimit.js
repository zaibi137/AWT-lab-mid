/**
 * middleware/rateLimit.js — Database-backed rate limiter for the participant login endpoint.
 * Allows MAX_ATTEMPTS within WINDOW_MS per unique key (IP + registrationId).
 * State lives in MongoDB/file so it survives serverless cold starts.
 */

const { getLoginAttempt, upsertLoginAttempt } = require("../services/db");

const MAX_ATTEMPTS = 5;
const WINDOW_MS    = 15 * 60 * 1000; // 15 minutes

/**
 * Rate-limit middleware.
 * Key = IP address. Attach to portal login route.
 */
async function rateLimitPortalLogin(req, res, next) {
  const key = req.ip || req.headers["x-forwarded-for"] || "unknown";
  const now = Date.now();

  try {
    const record = await getLoginAttempt(key);

    // If no record or the window has expired, start a fresh window.
    if (!record || now - new Date(record.windowStart).getTime() >= WINDOW_MS) {
      await upsertLoginAttempt(key, 1, new Date(now).toISOString());
      return next();
    }

    if (record.count >= MAX_ATTEMPTS) {
      const retryAfter = Math.ceil((WINDOW_MS - (now - new Date(record.windowStart).getTime())) / 1000);
      return res.status(429).json({
        error: `Too many login attempts. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
      });
    }

    // Increment count within the same window.
    await upsertLoginAttempt(key, record.count + 1, record.windowStart);
    next();
  } catch (err) {
    // On DB error, allow the request (fail open — rate limit is a safeguard, not a gate).
    console.error("[rateLimit] Error:", err.message);
    next();
  }
}

module.exports = { rateLimitPortalLogin };
