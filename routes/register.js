/**
 * routes/register.js — Team registration with payment receipt upload.
 * POST /api/register   (multipart/form-data)
 *
 * Validates: all fields, reg number format, unique reg numbers,
 * receipt file type (magic bytes) and size.
 * Stores registration and receipt blob.
 */

const express  = require("express");
const multer   = require("multer");
const { PROGRAMS, INSTITUTE_NAME, COMSATS_REG_NO } = require("../options");
const db       = require("../services/db");
const { validateReceipt, MAX_SIZE } = require("../services/receipts");

const router  = express.Router();

// Use memory storage so we can inspect the buffer for magic bytes.
// Vercel has a 4.5 MB body limit; we enforce 4 MB here to leave headroom.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 } });

// ─── Helpers ──────────────────────────────────────────────────────────────────

const clean  = v  => String(v || "").trim();
const EMAIL  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE  = /^03\d{9}$/;

function checkMember(fields, n, errors) {
  const name    = clean(fields[`member${n}Name`]);
  const regNo   = clean(fields[`member${n}RegNo`]).toUpperCase();
  const program = clean(fields[`member${n}Program`]);

  if (name.length < 3)              errors[`member${n}Name`]    = "Enter the full name (at least 3 characters).";
  if (!PROGRAMS.includes(program))  errors[`member${n}Program`] = "Choose a degree program.";
  if (!COMSATS_REG_NO.test(regNo))  errors[`member${n}RegNo`]   = "Use the format FA23-BSE-062.";
}

function parseMember(fields, n) {
  return {
    name:    clean(fields[`member${n}Name`]),
    regNo:   clean(fields[`member${n}RegNo`]).toUpperCase(),
    program: clean(fields[`member${n}Program`]),
  };
}

// ─── POST /api/register ───────────────────────────────────────────────────────

router.post("/", upload.single("receipt"), async (req, res) => {
  try {
    const f       = req.body;
    const errors  = {};

    // — Parse members —
    const m1       = parseMember(f, 1);
    const m2Raw    = { name: clean(f.member2Name), regNo: clean(f.member2RegNo), program: clean(f.member2Program) };
    const hasM2    = Boolean(m2Raw.name || m2Raw.regNo || m2Raw.program);
    const m2       = hasM2 ? { ...m2Raw, regNo: m2Raw.regNo.toUpperCase() } : null;

    checkMember(f, 1, errors);
    if (hasM2) {
      checkMember(f, 2, errors);
      if (!errors.member2RegNo && m1.regNo === (m2?.regNo || ""))
        errors.member2RegNo = "Teammate must be a different person.";
    }

    // — Contact & payment —
    const teamName      = clean(f.teamName);
    const email         = clean(f.email).toLowerCase();
    const phone         = clean(f.phone);
    const paymentMethod = clean(f.paymentMethod);
    const transactionId = clean(f.transactionId);

    if (!EMAIL.test(email))   errors.email = "Enter a valid email address.";
    if (!PHONE.test(phone))   errors.phone = "Use the format 03001234567.";
    if (!["Easypaisa", "JazzCash", "Bank transfer"].includes(paymentMethod))
      errors.paymentMethod = "Choose a payment method.";
    if (transactionId.length < 4)
      errors.transactionId = "Enter the transaction ID.";

    // — Receipt —
    if (!req.file) {
      errors.receipt = "Payment receipt is required (JPG, PNG or PDF, max 2 MB).";
    } else {
      const check = validateReceipt(req.file.buffer);
      if (!check.ok) errors.receipt = check.error;
    }

    if (Object.keys(errors).length) return res.status(400).json({ errors });

    // — Build the registration record —
    const members   = hasM2 ? [m1, m2] : [m1];
    const memberIds = members.map(m => m.regNo); // unique index enforced in DB

    // Check for duplicate reg numbers before inserting.
    for (const rn of memberIds) {
      const exists = await db.findRegistrationByMemberId(rn);
      if (exists) {
        errors[members.findIndex(m => m.regNo === rn) === 0 ? "member1RegNo" : "member2RegNo"] =
          `${rn} is already registered.`;
      }
    }
    if (Object.keys(errors).length) return res.status(400).json({ errors });

    // Generate VS-NNNN id.
    const all  = await db.getAllRegistrations();
    const max  = all.reduce((m, r) => Math.max(m, Number(String(r.id).slice(3)) || 0), 0);
    const id   = "VS-" + String(max + 1).padStart(4, "0");

    // Save receipt first (get receiptId).
    const { contentType } = validateReceipt(req.file.buffer); // re-read (already validated above)
    const receiptId = await db.saveReceipt(id, req.file.originalname, contentType, req.file.buffer);

    // Save registration.
    await db.createRegistration({
      id,
      teamName:      teamName || members[0].name,
      email,
      phone,
      paymentMethod,
      transactionId,
      status:        "pending",
      rejectReason:  null,
      statusUpdatedAt: null,
      venue:         null,
      members,
      memberIds,
      institute:     INSTITUTE_NAME, // fixed for all registrations
      receiptId,
      createdAt:     new Date().toISOString(),
    });

    res.status(201).json({ id });
  } catch (err) {
    // Handle unique-constraint violation from MongoDB.
    if (err.code === 11000 || (err.message && err.message.startsWith("DUPLICATE:"))) {
      const rn = err.message?.split(":")[1] || "unknown";
      return res.status(400).json({ errors: { member1RegNo: `${rn} is already registered.` } });
    }
    console.error("[register]", err);
    res.status(500).json({ error: "Registration failed. Please try again." });
  }
});

module.exports = router;
