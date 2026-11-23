/**
 * routes/portal.js — Participant portal API.
 * Login, registration status, competition start and submission.
 * All time decisions use the SERVER clock (Date.now()).
 */

const express  = require("express");
const db       = require("../services/db");
const { signParticipantToken } = require("../services/tokens");
const { requireParticipant }   = require("../middleware/auth");
const { rateLimitPortalLogin } = require("../middleware/rateLimit");

const router = express.Router();

/** Validate a Google Drive URL (https, drive.google.com or docs.google.com). */
const DRIVE_URL = /^https:\/\/(drive|docs)\.google\.com\/.+/i;

function isDriveUrl(url) {
  return typeof url === "string" && DRIVE_URL.test(url.trim());
}

// ─── POST /api/portal/login ───────────────────────────────────────────────────

/**
 * Log in with Registration ID + either team member's reg number.
 * Rate-limited: 5 attempts / 15 min per IP.
 */
router.post("/login", rateLimitPortalLogin, async (req, res) => {
  try {
    const registrationId = String(req.body.registrationId || "").trim().toUpperCase();
    const regNo          = String(req.body.regNo || "").trim().toUpperCase();

    if (!registrationId || !regNo) {
      return res.status(400).json({ error: "Registration ID and registration number are required." });
    }

    const reg = await db.getRegistration(registrationId);
    if (!reg) return res.status(401).json({ error: "Invalid Registration ID or registration number." });

    const match = (reg.memberIds || []).some(id => id.toUpperCase() === regNo);
    if (!match)  return res.status(401).json({ error: "Invalid Registration ID or registration number." });

    const token = signParticipantToken(registrationId);
    res.json({ token });
  } catch (err) {
    console.error("[portal/login]", err);
    res.status(500).json({ error: "Login failed. Please try again." });
  }
});

// ─── GET /api/portal/me ───────────────────────────────────────────────────────

/**
 * Returns the team's registration status and, when published, their own result.
 * Never exposes: other teams' data, judge notes, or the admin Drive link.
 */
router.get("/me", requireParticipant, async (req, res) => {
  try {
    const { registrationId } = req.participant;
    const reg = await db.getRegistration(registrationId);
    if (!reg) return res.status(404).json({ error: "Registration not found." });

    // Determine effective status (backward compat: paymentVerified=true → accepted).
    const status = reg.status || (reg.paymentVerified ? "accepted" : "pending");

    // Resolve the venue (per-registration override or default from settings).
    let venue = null;
    if (status === "accepted") {
      const settings = await db.getSettings();
      venue = reg.venue || settings.defaultVenue || null;
    }

    // Own result (only if published).
    let ownResult = null;
    const results = await db.getResults();
    if (results.published) {
      const posMap = { first: 1, second: 2, third: 3 };
      for (const [key, pos] of Object.entries(posMap)) {
        if (results[key] === registrationId) {
          ownResult = pos; // 1, 2, or 3
          break;
        }
      }
      if (!ownResult) ownResult = 0; // participated but no position
    }

    res.json({
      id:          reg.id,
      teamName:    reg.teamName,
      members:     reg.members.map(m => ({ name: m.name, regNo: m.regNo, program: m.program })),
      status,
      rejectReason: status === "rejected" ? (reg.rejectReason || null) : null,
      venue,
      result:      ownResult, // null = not published, 0 = participated, 1/2/3 = position
    });
  } catch (err) {
    console.error("[portal/me]", err);
    res.status(500).json({ error: "Could not load your registration." });
  }
});

// ─── GET /api/portal/settings ─────────────────────────────────────────────────

/** Returns competition gate status and duration. No Drive link exposed here. */
router.get("/settings", requireParticipant, async (req, res) => {
  try {
    const s = await db.getSettings();
    res.json({ gateOpen: s.gateOpen, durationMinutes: s.durationMinutes });
  } catch (err) {
    console.error("[portal/settings]", err);
    res.status(500).json({ error: "Could not load competition settings." });
  }
});

// ─── POST /api/portal/start ───────────────────────────────────────────────────

/**
 * Start the team's competition window. IDEMPOTENT.
 * - Gate must be open.
 * - Team must be accepted.
 * - Only one attempt per team (second call returns the existing attempt).
 * Uses server clock for startedAt and endsAt.
 */
router.post("/start", requireParticipant, async (req, res) => {
  try {
    const { registrationId } = req.participant;
    const reg = await db.getRegistration(registrationId);
    if (!reg) return res.status(404).json({ error: "Registration not found." });

    const status = reg.status || (reg.paymentVerified ? "accepted" : "pending");
    if (status !== "accepted") {
      return res.status(403).json({ error: "Your registration must be accepted before you can start." });
    }

    // Check gate BEFORE creating attempt, but only for new starts.
    const existing = await db.getAttempt(registrationId);
    if (!existing) {
      const settings = await db.getSettings();
      if (!settings.gateOpen) {
        return res.status(403).json({ error: "The competition gate is not open yet. Please wait for the organizers." });
      }
    }

    const now           = Date.now();
    const settings      = await db.getSettings();
    const durationMs    = (existing?.durationMinutes || settings.durationMinutes) * 60 * 1000;
    const startedAt     = existing ? existing.startedAt : new Date(now).toISOString();
    const endsAt        = existing ? existing.endsAt : new Date(now + durationMs).toISOString();

    const { attempt } = await db.createAttempt(
      registrationId,
      startedAt,
      endsAt,
      settings.durationMinutes
    );

    res.json({ attempt: sanitizeAttempt(attempt, now) });
  } catch (err) {
    console.error("[portal/start]", err);
    res.status(500).json({ error: "Could not start the competition. Please try again." });
  }
});

// ─── GET /api/portal/attempt ─────────────────────────────────────────────────

/**
 * Returns the current attempt for this team.
 * The admin's Drive link is ONLY included when now < endsAt.
 */
router.get("/attempt", requireParticipant, async (req, res) => {
  try {
    const { registrationId } = req.participant;
    const attempt = await db.getAttempt(registrationId);
    if (!attempt) return res.json({ attempt: null });

    const now = Date.now();
    const result = sanitizeAttempt(attempt, now);

    // Include admin Drive link only while time is still running.
    if (now < new Date(attempt.endsAt).getTime()) {
      const settings = await db.getSettings();
      result.adminDriveLink = settings.driveLink || null;
    }

    res.json({ attempt: result, serverNow: now });
  } catch (err) {
    console.error("[portal/attempt]", err);
    res.status(500).json({ error: "Could not load competition status." });
  }
});

// ─── POST /api/portal/submit ──────────────────────────────────────────────────

/**
 * Submit (or update) the team's Google Drive link.
 * Server enforces: team accepted, attempt started, now < endsAt.
 * Submission can be updated until the deadline.
 */
router.post("/submit", requireParticipant, async (req, res) => {
  try {
    const { registrationId } = req.participant;
    const driveLink = String(req.body.driveLink || "").trim();

    if (!isDriveUrl(driveLink)) {
      return res.status(400).json({ error: "Enter a valid Google Drive link (must start with https://drive.google.com or https://docs.google.com)." });
    }

    // Validate team status.
    const reg = await db.getRegistration(registrationId);
    if (!reg) return res.status(404).json({ error: "Registration not found." });
    const status = reg.status || (reg.paymentVerified ? "accepted" : "pending");
    if (status !== "accepted") {
      return res.status(403).json({ error: "Your registration is not accepted." });
    }

    // Validate attempt.
    const attempt = await db.getAttempt(registrationId);
    if (!attempt) {
      return res.status(403).json({ error: "Your competition window has not started yet." });
    }

    const now = Date.now();
    if (now >= new Date(attempt.endsAt).getTime()) {
      return res.status(403).json({ error: "Your competition time has ended. Submissions are closed." });
    }

    const updated = await db.updateSubmission(registrationId, driveLink, new Date(now).toISOString());
    res.json({ attempt: sanitizeAttempt(updated, now), serverNow: now });
  } catch (err) {
    console.error("[portal/submit]", err);
    res.status(500).json({ error: "Submission failed. Please try again." });
  }
});

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Strip internal fields and add computed `timeOver` flag. */
function sanitizeAttempt(attempt, now) {
  if (!attempt) return null;
  return {
    startedAt:      attempt.startedAt,
    endsAt:         attempt.endsAt,
    durationMinutes: attempt.durationMinutes,
    timeOver:       now >= new Date(attempt.endsAt).getTime(),
    submission:     attempt.submission || null,
    // adminDriveLink added by the caller only when appropriate
  };
}

module.exports = router;
