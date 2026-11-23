/**
 * routes/admin.js — All admin API endpoints.
 * Registrations tab, Settings tab, Live monitoring tab, Results/Judging tab.
 * All routes require a valid admin HMAC token except POST /api/admin/login.
 */

const express = require("express");
const db      = require("../services/db");
const { signAdminToken }  = require("../services/tokens");
const { requireAdmin }    = require("../middleware/auth");
const { sendAccepted, sendRejected } = require("../services/mailer");

const router = express.Router();

const ADMIN_USER     = process.env.ADMIN_USER;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// In production, refuse to start if no password is set.
if (process.env.NODE_ENV === "production" && !ADMIN_PASSWORD) {
  console.error("FATAL: ADMIN_PASSWORD env var is not set. Refusing to start in production.");
  process.exit(1);
}

/** Validate a Google Drive URL (https only, drive.google.com or docs.google.com). */
const DRIVE_URL = /^https:\/\/(drive|docs)\.google\.com\/.+/i;
function isDriveUrl(url) {
  return typeof url === "string" && DRIVE_URL.test(url.trim());
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

router.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  const user = ADMIN_USER || "admin";
  const pass = ADMIN_PASSWORD || "admin123"; // insecure fallback for dev mode only
  if (username !== user || password !== pass) {
    return res.status(401).json({ error: "Wrong username or password." });
  }
  res.json({ token: signAdminToken() });
});

// ─── Registrations ────────────────────────────────────────────────────────────

/** GET /api/admin/registrations?status=&q= */
router.get("/registrations", requireAdmin, async (req, res) => {
  try {
    let list = await db.getAllRegistrations();
    // Backward compat: treat paymentVerified=true as accepted.
    list = list.map(r => ({ ...r, status: r.status || (r.paymentVerified ? "accepted" : "pending") }));

    const { status, q } = req.query;
    if (status) list = list.filter(r => r.status === status);
    if (q) {
      const lc = q.toLowerCase();
      list = list.filter(r => {
        const text = [r.id, r.teamName, r.email, r.phone, r.transactionId,
          ...r.members.flatMap(m => [m.name, m.regNo])].join(" ").toLowerCase();
        return text.includes(lc);
      });
    }
    res.json(list);
  } catch (err) {
    console.error("[admin/registrations]", err);
    res.status(500).json({ error: "Could not load registrations." });
  }
});

/** PATCH /api/admin/registrations/:id/status — accept or reject. */
router.patch("/registrations/:id/status", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, rejectReason } = req.body || {};

    if (!["pending", "accepted", "rejected"].includes(status)) {
      return res.status(400).json({ error: "Status must be pending, accepted or rejected." });
    }

    const updated = await db.updateRegistrationStatus(id, status, rejectReason || null);
    if (!updated) return res.status(404).json({ error: "Registration not found." });

    // Send email asynchronously — never await, never throw.
    const settings = await db.getSettings();
    const venue    = updated.venue || settings.defaultVenue || null;
    if (status === "accepted") sendAccepted(updated, venue).catch(() => {});
    if (status === "rejected") sendRejected(updated, rejectReason || null).catch(() => {});

    res.json(updated);
  } catch (err) {
    console.error("[admin/status]", err);
    res.status(500).json({ error: "Could not update status." });
  }
});

/** PATCH /api/admin/registrations/:id/venue — override venue for one team. */
router.patch("/registrations/:id/venue", requireAdmin, async (req, res) => {
  try {
    const { venue } = req.body || {};
    const updated = await db.setRegistrationVenue(req.params.id, String(venue || "").trim() || null);
    if (!updated) return res.status(404).json({ error: "Registration not found." });
    res.json(updated);
  } catch (err) {
    console.error("[admin/venue]", err);
    res.status(500).json({ error: "Could not update venue." });
  }
});

/** DELETE /api/admin/registrations/:id */
router.delete("/registrations/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const deleted = await db.deleteRegistration(id);
    if (!deleted) return res.status(404).json({ error: "Registration not found." });
    // Clean up associated data.
    await db.deleteReceiptByRegistration(id).catch(() => {});
    await db.resetAttempt(id).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin/delete]", err);
    res.status(500).json({ error: "Could not delete registration." });
  }
});

/** GET /api/admin/registrations/:id/receipt — stream the receipt blob. */
router.get("/registrations/:id/receipt", requireAdmin, async (req, res) => {
  try {
    const reg = await db.getRegistration(req.params.id);
    if (!reg || !reg.receiptId) return res.status(404).json({ error: "Receipt not found." });

    const receipt = await db.getReceipt(reg.receiptId);
    if (!receipt) return res.status(404).json({ error: "Receipt file not found." });

    res.set("Content-Type", receipt.contentType);
    res.set("Content-Disposition", `inline; filename="${receipt.filename}"`);
    res.set("Cache-Control", "no-store"); // never publicly cache receipts
    res.send(receipt.data);
  } catch (err) {
    console.error("[admin/receipt]", err);
    res.status(500).json({ error: "Could not load receipt." });
  }
});

/** GET /api/admin/export.csv — download registrations as CSV. */
router.get("/export.csv", requireAdmin, async (req, res) => {
  try {
    const list = await db.getAllRegistrations();
    const settings = await db.getSettings();

    const header = [
      "ID", "Team", "Email", "Phone", "Payment", "Transaction ID",
      "Status", "Reject Reason", "Venue", "Registered At", "Status Updated At",
      "M1 Name", "M1 Reg No", "M1 Program",
      "M2 Name", "M2 Reg No", "M2 Program",
    ];

    const rows = list.map(r => {
      const status = r.status || (r.paymentVerified ? "accepted" : "pending");
      const venue  = r.venue || settings.defaultVenue || "";
      const [a, b = {}] = r.members;
      return [
        r.id, r.teamName, r.email, r.phone, r.paymentMethod, r.transactionId,
        status, r.rejectReason || "", venue, r.createdAt, r.statusUpdatedAt || "",
        a.name, a.regNo, a.program,
        b.name || "", b.regNo || "", b.program || "",
      ].map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
    });

    res.type("text/csv")
       .attachment("vspark-registrations.csv")
       .send([header.join(","), ...rows].join("\n"));
  } catch (err) {
    console.error("[admin/export]", err);
    res.status(500).json({ error: "Could not generate CSV." });
  }
});

// ─── Settings ─────────────────────────────────────────────────────────────────

/** GET /api/admin/settings */
router.get("/settings", requireAdmin, async (req, res) => {
  try {
    res.json(await db.getSettings());
  } catch (err) {
    res.status(500).json({ error: "Could not load settings." });
  }
});

/** PATCH /api/admin/settings */
router.patch("/settings", requireAdmin, async (req, res) => {
  try {
    const { driveLink, durationMinutes, gateOpen, defaultVenue } = req.body || {};
    const patch = {};

    if (driveLink !== undefined) {
      if (driveLink && !isDriveUrl(driveLink)) {
        return res.status(400).json({ error: "Drive link must be a valid https://drive.google.com or docs.google.com URL." });
      }
      patch.driveLink = driveLink || "";
    }
    if (durationMinutes !== undefined) {
      const mins = parseInt(durationMinutes, 10);
      if (!mins || mins < 1 || mins > 240) {
        return res.status(400).json({ error: "Duration must be between 1 and 240 minutes." });
      }
      patch.durationMinutes = mins;
    }
    if (typeof gateOpen === "boolean") patch.gateOpen = gateOpen;
    if (defaultVenue !== undefined)    patch.defaultVenue = String(defaultVenue || "").trim();

    res.json(await db.saveSettings(patch));
  } catch (err) {
    console.error("[admin/settings]", err);
    res.status(500).json({ error: "Could not save settings." });
  }
});

// ─── Live monitoring ──────────────────────────────────────────────────────────

/** GET /api/admin/live — all accepted teams joined with their attempt data. */
router.get("/live", requireAdmin, async (req, res) => {
  try {
    const all      = await db.getAllRegistrations();
    const attempts = await db.getAllAttempts();
    const settings = await db.getSettings();
    const now      = Date.now();

    const attemptMap = Object.fromEntries(attempts.map(a => [a.registrationId, a]));

    const accepted = all
      .filter(r => (r.status || (r.paymentVerified ? "accepted" : "pending")) === "accepted")
      .map(r => {
        const a     = attemptMap[r.id] || null;
        const venue = r.venue || settings.defaultVenue || "";
        let state   = "not_started";
        let remaining = null;

        if (a) {
          const end = new Date(a.endsAt).getTime();
          if (now >= end) {
            state = a.submission ? "submitted" : "time_over";
          } else {
            state     = "running";
            remaining = Math.max(0, end - now);
          }
        }

        return {
          id:       r.id,
          teamName: r.teamName,
          members:  r.members,
          venue,
          state,
          remaining,
          startedAt:    a?.startedAt || null,
          endsAt:       a?.endsAt || null,
          submission:   a?.submission || null,
          serverNow:    now,
        };
      });

    res.json({ teams: accepted, serverNow: now });
  } catch (err) {
    console.error("[admin/live]", err);
    res.status(500).json({ error: "Could not load live data." });
  }
});

/** POST /api/admin/attempts/:registrationId/reset — allow a team to restart. */
router.post("/attempts/:registrationId/reset", requireAdmin, async (req, res) => {
  try {
    await db.resetAttempt(req.params.registrationId);
    res.json({ ok: true });
  } catch (err) {
    console.error("[admin/reset]", err);
    res.status(500).json({ error: "Could not reset attempt." });
  }
});

/** PATCH /api/admin/attempts/:registrationId/extend — add minutes to a team's deadline. */
router.patch("/attempts/:registrationId/extend", requireAdmin, async (req, res) => {
  try {
    const extra = parseInt(req.body?.extraMinutes, 10);
    if (!extra || extra < 1 || extra > 60) {
      return res.status(400).json({ error: "extraMinutes must be between 1 and 60." });
    }
    const updated = await db.extendAttempt(req.params.registrationId, extra);
    if (!updated) return res.status(404).json({ error: "No attempt found for this team." });
    res.json({ attempt: updated });
  } catch (err) {
    console.error("[admin/extend]", err);
    res.status(500).json({ error: "Could not extend attempt." });
  }
});

// ─── Results / Judging ────────────────────────────────────────────────────────

/** GET /api/admin/results — all submissions + reviews + current positions. */
router.get("/results", requireAdmin, async (req, res) => {
  try {
    const all      = await db.getAllRegistrations();
    const attempts = await db.getAllAttempts();
    const reviews  = await db.getAllReviews();
    const results  = await db.getResults();

    const attemptMap = Object.fromEntries(attempts.map(a => [a.registrationId, a]));
    const reviewMap  = Object.fromEntries(reviews.map(rv => [rv.registrationId, rv]));

    // Position lookup: registrationId → position number.
    const positionOf = {};
    if (results.first)  positionOf[results.first]  = 1;
    if (results.second) positionOf[results.second] = 2;
    if (results.third)  positionOf[results.third]  = 3;

    // Build submission list (accepted teams with a submission).
    const accepted = all.filter(r => (r.status || (r.paymentVerified ? "accepted" : "pending")) === "accepted");

    const withSubmission = [];
    const withoutSubmission = [];

    for (const r of accepted) {
      const a  = attemptMap[r.id];
      const rv = reviewMap[r.id] || { reviewed: false, notes: "" };
      if (a?.submission?.driveLink) {
        const startMs = new Date(a.startedAt).getTime();
        const subMs   = new Date(a.submission.submittedAt).getTime();
        withSubmission.push({
          id:         r.id,
          teamName:   r.teamName,
          members:    r.members,
          venue:      r.venue,
          startedAt:  a.startedAt,
          endsAt:     a.endsAt,
          submission: a.submission,
          submittedAfterMinutes: Math.round((subMs - startMs) / 60000),
          position:   positionOf[r.id] || null, // admin sees positions pre-publish
          reviewed:   rv.reviewed || false,
          notes:      rv.notes || "",            // judge notes — admin only
        });
      } else {
        withoutSubmission.push({
          id:       r.id,
          teamName: r.teamName,
          members:  r.members,
          venue:    r.venue,
          startedAt: a?.startedAt || null,
        });
      }
    }

    const reviewedCount = withSubmission.filter(t => t.reviewed).length;

    res.json({
      withSubmission,
      withoutSubmission,
      results: { ...results },
      reviewedCount,
      totalSubmissions: withSubmission.length,
    });
  } catch (err) {
    console.error("[admin/results]", err);
    res.status(500).json({ error: "Could not load results." });
  }
});

/** PATCH /api/admin/results/position — assign 1st/2nd/3rd to a team. */
router.patch("/results/position", requireAdmin, async (req, res) => {
  try {
    const { registrationId, position } = req.body || {};

    // Validate position value.
    if (position !== null && ![1, 2, 3].includes(Number(position))) {
      return res.status(400).json({ error: "Position must be 1, 2, 3 or null." });
    }

    // Only teams with a submission can be ranked.
    if (position !== null && registrationId) {
      const attempt = await db.getAttempt(registrationId);
      if (!attempt?.submission?.driveLink) {
        return res.status(400).json({ error: "Only teams with a submission can be assigned a position." });
      }
    }

    const results = await db.getResults();
    if (results.published) {
      return res.status(400).json({ error: "Results are published. Unpublish before editing positions." });
    }

    const keyMap = { 1: "first", 2: "second", 3: "third" };
    const patch  = {};

    if (position === null) {
      // Remove position from this team.
      for (const [key, id] of Object.entries({ first: results.first, second: results.second, third: results.third })) {
        if (id === registrationId) patch[key] = null;
      }
    } else {
      const key = keyMap[Number(position)];
      // Clear any other position this team currently holds.
      for (const [k, id] of Object.entries({ first: results.first, second: results.second, third: results.third })) {
        if (id === registrationId && k !== key) patch[k] = null;
      }
      // Check if the slot is taken by someone else; return warning so the UI can confirm.
      const currentHolder = results[key];
      if (currentHolder && currentHolder !== registrationId) {
        // The UI should confirm and then resend with force=true.
        if (!req.body.force) {
          const holder = await db.getRegistration(currentHolder);
          return res.status(409).json({
            conflict: true,
            holderName: holder?.teamName || holder?.id,
            message: `Position ${position} is currently held by ${holder?.teamName || currentHolder}. Send again with force=true to replace.`,
          });
        }
      }
      patch[key] = registrationId;
    }

    const updated = await db.saveResults(patch);
    res.json(updated);
  } catch (err) {
    console.error("[admin/position]", err);
    res.status(500).json({ error: "Could not update position." });
  }
});

/** PATCH /api/admin/results/review/:registrationId — save judge notes. */
router.patch("/results/review/:registrationId", requireAdmin, async (req, res) => {
  try {
    const { reviewed, notes } = req.body || {};
    const patch = {};
    if (typeof reviewed === "boolean") patch.reviewed = reviewed;
    if (notes !== undefined) patch.notes = String(notes || "").slice(0, 500); // max 500 chars
    const updated = await db.saveReview(req.params.registrationId, patch);
    res.json(updated);
  } catch (err) {
    console.error("[admin/review]", err);
    res.status(500).json({ error: "Could not save review." });
  }
});

/** POST /api/admin/results/publish — publish results (all 3 positions must be filled). */
router.post("/results/publish", requireAdmin, async (req, res) => {
  try {
    const results = await db.getResults();
    if (!results.first || !results.second || !results.third) {
      return res.status(400).json({ error: "All three positions (1st, 2nd, 3rd) must be assigned before publishing." });
    }
    const updated = await db.saveResults({ published: true, publishedAt: new Date().toISOString() });
    res.json(updated);
  } catch (err) {
    console.error("[admin/publish]", err);
    res.status(500).json({ error: "Could not publish results." });
  }
});

/** POST /api/admin/results/unpublish — unpublish results. */
router.post("/results/unpublish", requireAdmin, async (req, res) => {
  try {
    const updated = await db.saveResults({ published: false, publishedAt: null });
    res.json(updated);
  } catch (err) {
    console.error("[admin/unpublish]", err);
    res.status(500).json({ error: "Could not unpublish results." });
  }
});

/** GET /api/admin/results/export.csv — download results as CSV. */
router.get("/results/export.csv", requireAdmin, async (req, res) => {
  try {
    const all      = await db.getAllRegistrations();
    const attempts = await db.getAllAttempts();
    const reviews  = await db.getAllReviews();
    const results  = await db.getResults();

    const attemptMap = Object.fromEntries(attempts.map(a => [a.registrationId, a]));
    const reviewMap  = Object.fromEntries(reviews.map(rv => [rv.registrationId, rv]));

    const positionOf = {};
    if (results.first)  positionOf[results.first]  = 1;
    if (results.second) positionOf[results.second] = 2;
    if (results.third)  positionOf[results.third]  = 3;

    const accepted = all.filter(r => (r.status || (r.paymentVerified ? "accepted" : "pending")) === "accepted");

    const header = ["Position", "Team ID", "Team Name", "M1 Name", "M1 Reg No", "M2 Name", "M2 Reg No",
                    "Venue", "Drive Link", "Submitted At", "Submitted After (min)", "Reviewed", "Notes"];
    const rows = accepted
      .filter(r => attemptMap[r.id]?.submission?.driveLink)
      .sort((a, b) => (positionOf[a.id] || 999) - (positionOf[b.id] || 999))
      .map(r => {
        const a  = attemptMap[r.id];
        const rv = reviewMap[r.id] || {};
        const [m1, m2 = {}] = r.members;
        const startMs = new Date(a.startedAt).getTime();
        const subMs   = new Date(a.submission.submittedAt).getTime();
        return [
          positionOf[r.id] || "",
          r.id, r.teamName || m1.name,
          m1.name, m1.regNo, m2.name || "", m2.regNo || "",
          r.venue || "", a.submission.driveLink, a.submission.submittedAt,
          Math.round((subMs - startMs) / 60000),
          rv.reviewed ? "Yes" : "No", rv.notes || "",
        ].map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
      });

    res.type("text/csv").attachment("vspark-results.csv").send([header.join(","), ...rows].join("\n"));
  } catch (err) {
    console.error("[admin/results-export]", err);
    res.status(500).json({ error: "Could not export results." });
  }
});

module.exports = router;
