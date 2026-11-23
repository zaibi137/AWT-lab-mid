/**
 * server.js — VSPARK Portal entry point.
 * Mounts all route modules and serves static files from /public.
 * Works locally (npm start) and on Vercel (serverless).
 */

const express = require("express");
const path    = require("path");

const app = express();

// ─── Body parsing ─────────────────────────────────────────────────────────────
// JSON for most API calls; multipart handled per-route by multer.
app.use(express.json({ limit: "20kb" }));

// ─── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ─── Page routes (serve HTML files for SPA-style navigation) ─────────────────
const pub = p => (req, res) => res.sendFile(path.join(__dirname, "public", p));
app.get("/register", pub("register.html"));
app.get("/portal",   pub("portal.html"));
app.get("/admin",    pub("admin.html"));

// ─── API routes ───────────────────────────────────────────────────────────────
app.use("/api/options",  require("./routes/options"));
app.use("/api/register", require("./routes/register"));
app.use("/api/admin",    require("./routes/admin"));
app.use("/api/portal",   require("./routes/portal"));
app.use("/api/public",   require("./routes/public"));

// ─── 404 fallback ────────────────────────────────────────────────────────────
app.use((req, res) => {
  if (req.path.startsWith("/api/")) return res.status(404).json({ error: "Not found." });
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ─── Start (local only; Vercel uses module.exports) ──────────────────────────
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`VSPARK portal:  http://localhost:${PORT}`);
    console.log(`Register:       http://localhost:${PORT}/register`);
    console.log(`Participant:    http://localhost:${PORT}/portal`);
    console.log(`Admin panel:    http://localhost:${PORT}/admin`);
  });
}

module.exports = app; // Required for Vercel serverless
