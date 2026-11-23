/**
 * routes/options.js — Provides dropdown data to registration and other forms.
 * GET /api/options
 */

const express = require("express");
const { PROGRAMS, INSTITUTE_NAME } = require("../options");

const router = express.Router();

router.get("/", (req, res) => {
  res.json({ programs: PROGRAMS, institute: INSTITUTE_NAME });
});

module.exports = router;
