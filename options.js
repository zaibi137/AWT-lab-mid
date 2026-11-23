/**
 * options.js — shared constants for programs and institute.
 * All participants are from COMSATS University Islamabad, Vehari Campus.
 */

/** The fixed institute for all registrations. */
const INSTITUTE_NAME = "COMSATS University Islamabad, Vehari Campus";

/** Degree programs shown in the registration form dropdown. */
const PROGRAMS = [
  "BS Software Engineering (BSE)",
  "BS Computer Science (BCS)",
  "BS Artificial Intelligence (BAI)",
  "BS Data Science (BDS)",
  "BS Cyber Security (BCY)",
  "BS Computer Engineering (BCE)",
  "BS Electrical Engineering (BEE)",
  "BBA",
  "MS / PhD",
  "Other",
];

/** COMSATS registration number format: FA23-BSE-062 or SP24-BCS-015 */
const COMSATS_REG_NO = /^(FA|SP)\d{2}-[A-Z]{2,4}-\d{3}$/;

module.exports = { INSTITUTE_NAME, PROGRAMS, COMSATS_REG_NO };
