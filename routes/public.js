/**
 * routes/public.js — Public endpoints that require no authentication.
 * GET /api/public/winners — returns winners only after admin publishes results.
 * GET /api/public/servertime — returns server timestamp for client clock sync.
 */

const express = require("express");
const db      = require("../services/db");

const router = express.Router();

/** GET /api/public/winners — returns 1st/2nd/3rd team names only (no emails, phones, links). */
router.get("/winners", async (req, res) => {
  try {
    const results = await db.getResults();
    if (!results.published) return res.json({ published: false });

    // Resolve each position to safe public data (names only).
    const resolve = async (id) => {
      if (!id) return null;
      const reg = await db.getRegistration(id);
      if (!reg) return null;
      return {
        registrationId: reg.id,
        teamName: reg.teamName || reg.members[0].name,
        members:  reg.members.map(m => ({ name: m.name })), // no reg numbers, emails or phones
      };
    };

    res.json({
      published:  true,
      publishedAt: results.publishedAt,
      first:  await resolve(results.first),
      second: await resolve(results.second),
      third:  await resolve(results.third),
    });
  } catch (err) {
    console.error("[public/winners]", err);
    res.status(500).json({ error: "Could not load results." });
  }
});

/** GET /api/public/servertime — lets the client compute a clock offset. */
router.get("/servertime", (req, res) => {
  res.json({ now: Date.now() });
});

module.exports = router;
