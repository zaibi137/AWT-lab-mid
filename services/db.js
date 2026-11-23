/**
 * services/db.js — Storage layer.
 * Uses MongoDB when MONGODB_URI is set; falls back to local JSON files for development.
 * All functions are async so callers are storage-agnostic.
 */

const fs   = require("fs");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");

const IS_MONGO = Boolean(process.env.MONGODB_URI);
const DATA_DIR = path.join(__dirname, "..", "data");

// ─── MongoDB helpers ──────────────────────────────────────────────────────────

let _client = null;

/** Returns a connected MongoClient, reusing the cached connection between invocations. */
async function mongoClient() {
  // Cache on global so the same connection survives serverless warm invocations.
  if (global._mongoClient && global._mongoClient.topology?.isConnected()) {
    return global._mongoClient;
  }
  const client = new MongoClient(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 5000,
    socketTimeoutMS: 10000,
  });
  await client.connect();
  global._mongoClient = client;
  await ensureIndexes(client);
  return client;
}

async function db() {
  const client = await mongoClient();
  return client.db(); // db name comes from the URI
}

/** Create indexes once after first connection. */
async function ensureIndexes(client) {
  const d = client.db();
  // Unique reg-number index (each student only once).
  await d.collection("registrations").createIndex({ memberIds: 1 }, { unique: true, sparse: true }).catch(() => {});
  // One attempt per registration.
  await d.collection("attempts").createIndex({ registrationId: 1 }, { unique: true }).catch(() => {});
  // Rate-limit window expiry (TTL — loginAttempts older than 15 min are removed).
  await d.collection("loginAttempts").createIndex({ windowStart: 1 }, { expireAfterSeconds: 900 }).catch(() => {});
  // Fast lookup for receipt by registrationId.
  await d.collection("receipts").createIndex({ registrationId: 1 }).catch(() => {});
  // Reviews by registrationId.
  await d.collection("reviews").createIndex({ registrationId: 1 }, { unique: true }).catch(() => {});
}

// ─── File-mode helpers ────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(filename, fallback) {
  ensureDataDir();
  const fp = path.join(DATA_DIR, filename);
  try { return JSON.parse(fs.readFileSync(fp, "utf8")); }
  catch { return fallback; }
}

function writeJson(filename, data) {
  ensureDataDir();
  fs.writeFileSync(path.join(DATA_DIR, filename), JSON.stringify(data, null, 2));
}

function readReceiptsDir() {
  const dir = path.join(DATA_DIR, "receipts");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Generate a VS-NNNN style registration ID from the current list length. */
function nextId(list) {
  const max = list.reduce((m, r) => Math.max(m, Number(String(r.id).slice(3)) || 0), 0);
  return "VS-" + String(max + 1).padStart(4, "0");
}

// ─── Registrations ───────────────────────────────────────────────────────────

async function getAllRegistrations() {
  if (IS_MONGO) {
    const col = (await db()).collection("registrations");
    return col.find({}, { projection: { _id: 0 } }).sort({ createdAt: 1 }).toArray();
  }
  return readJson("registrations.json", []);
}

async function getRegistration(id) {
  if (IS_MONGO) {
    return (await db()).collection("registrations").findOne({ id }, { projection: { _id: 0 } });
  }
  return readJson("registrations.json", []).find(r => r.id === id) || null;
}

/** Find a registration that contains the given regNo in its memberIds. */
async function findRegistrationByMemberId(regNo) {
  const upper = regNo.toUpperCase();
  if (IS_MONGO) {
    return (await db()).collection("registrations").findOne(
      { memberIds: upper }, { projection: { _id: 0 } }
    );
  }
  return readJson("registrations.json", []).find(r => (r.memberIds || []).includes(upper)) || null;
}

async function createRegistration(data) {
  if (IS_MONGO) {
    const col = (await db()).collection("registrations");
    // Let the unique index on memberIds enforce no duplicates.
    await col.insertOne({ ...data, _id: undefined }); // _id is auto-generated
    return { id: data.id };
  }
  const list = readJson("registrations.json", []);
  // Check for duplicate reg numbers in file mode.
  const existing = new Set(list.flatMap(r => r.memberIds || []));
  for (const rn of data.memberIds || []) {
    if (existing.has(rn)) throw new Error(`DUPLICATE:${rn}`);
  }
  const record = { ...data, id: data.id || nextId(list) };
  list.push(record);
  writeJson("registrations.json", list);
  return { id: record.id };
}

async function updateRegistrationStatus(id, status, rejectReason) {
  const patch = {
    status,
    rejectReason: rejectReason || null,
    statusUpdatedAt: new Date().toISOString(),
  };
  if (IS_MONGO) {
    await (await db()).collection("registrations").updateOne({ id }, { $set: patch });
    return getRegistration(id);
  }
  const list = readJson("registrations.json", []);
  const rec = list.find(r => r.id === id);
  if (!rec) return null;
  Object.assign(rec, patch);
  writeJson("registrations.json", list);
  return rec;
}

async function setRegistrationVenue(id, venue) {
  if (IS_MONGO) {
    await (await db()).collection("registrations").updateOne({ id }, { $set: { venue } });
    return getRegistration(id);
  }
  const list = readJson("registrations.json", []);
  const rec = list.find(r => r.id === id);
  if (!rec) return null;
  rec.venue = venue;
  writeJson("registrations.json", list);
  return rec;
}

async function deleteRegistration(id) {
  if (IS_MONGO) {
    const result = await (await db()).collection("registrations").deleteOne({ id });
    return result.deletedCount > 0;
  }
  const list = readJson("registrations.json", []);
  const remaining = list.filter(r => r.id !== id);
  if (remaining.length === list.length) return false;
  writeJson("registrations.json", remaining);
  return true;
}

// ─── Receipts ─────────────────────────────────────────────────────────────────

/**
 * Save a receipt blob.
 * In Mongo mode: stored as Binary data in the receipts collection.
 * In file mode: saved to data/receipts/<registrationId>_<filename>.
 * Returns a receiptId string.
 */
async function saveReceipt(registrationId, filename, contentType, buffer) {
  if (IS_MONGO) {
    const col = (await db()).collection("receipts");
    const doc = {
      registrationId,
      filename,
      contentType,
      size: buffer.length,
      data: buffer, // stored as BSON Binary
      uploadedAt: new Date().toISOString(),
    };
    const result = await col.insertOne(doc);
    return result.insertedId.toString();
  }
  // File mode: write to disk.
  const dir = readReceiptsDir();
  const safe = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = path.join(dir, `${registrationId}_${safe}`);
  fs.writeFileSync(filePath, buffer);
  const receiptId = `${registrationId}_${safe}`;
  // Store metadata in a JSON index.
  const index = readJson("receipts.json", []);
  index.push({ id: receiptId, registrationId, filename, contentType, size: buffer.length, filePath, uploadedAt: new Date().toISOString() });
  writeJson("receipts.json", index);
  return receiptId;
}

/**
 * Retrieve a receipt. Returns { filename, contentType, data: Buffer } or null.
 */
async function getReceipt(receiptId) {
  if (IS_MONGO) {
    const oid = ObjectId.isValid(receiptId) ? new ObjectId(receiptId) : null;
    if (!oid) return null;
    const doc = await (await db()).collection("receipts").findOne({ _id: oid });
    if (!doc) return null;
    return { filename: doc.filename, contentType: doc.contentType, data: Buffer.from(doc.data.buffer || doc.data) };
  }
  const index = readJson("receipts.json", []);
  const meta = index.find(r => r.id === receiptId);
  if (!meta || !fs.existsSync(meta.filePath)) return null;
  return { filename: meta.filename, contentType: meta.contentType, data: fs.readFileSync(meta.filePath) };
}

async function deleteReceiptByRegistration(registrationId) {
  if (IS_MONGO) {
    await (await db()).collection("receipts").deleteMany({ registrationId });
    return;
  }
  const index = readJson("receipts.json", []);
  for (const meta of index.filter(r => r.registrationId === registrationId)) {
    if (fs.existsSync(meta.filePath)) fs.unlinkSync(meta.filePath);
  }
  writeJson("receipts.json", index.filter(r => r.registrationId !== registrationId));
}

// ─── Settings ─────────────────────────────────────────────────────────────────

const SETTINGS_DEFAULTS = {
  driveLink: "",
  durationMinutes: parseInt(process.env.COMPETITION_MINUTES, 10) || 20,
  gateOpen: false,
  defaultVenue: "",
};

async function getSettings() {
  if (IS_MONGO) {
    const doc = await (await db()).collection("settings").findOne({}, { projection: { _id: 0 } });
    return { ...SETTINGS_DEFAULTS, ...(doc || {}) };
  }
  return { ...SETTINGS_DEFAULTS, ...readJson("settings.json", {}) };
}

async function saveSettings(patch) {
  const current = await getSettings();
  const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
  if (IS_MONGO) {
    await (await db()).collection("settings").replaceOne({}, updated, { upsert: true });
    return updated;
  }
  writeJson("settings.json", updated);
  return updated;
}

// ─── Attempts ─────────────────────────────────────────────────────────────────

async function getAttempt(registrationId) {
  if (IS_MONGO) {
    return (await db()).collection("attempts").findOne({ registrationId }, { projection: { _id: 0 } });
  }
  return readJson("attempts.json", []).find(a => a.registrationId === registrationId) || null;
}

async function getAllAttempts() {
  if (IS_MONGO) {
    return (await db()).collection("attempts").find({}, { projection: { _id: 0 } }).toArray();
  }
  return readJson("attempts.json", []);
}

async function createAttempt(registrationId, startedAt, endsAt, durationMinutes) {
  const doc = { registrationId, startedAt, endsAt, durationMinutes, submission: null };
  if (IS_MONGO) {
    const col = (await db()).collection("attempts");
    // Idempotent: if attempt exists, return it without modifying.
    const existing = await col.findOne({ registrationId }, { projection: { _id: 0 } });
    if (existing) return { created: false, attempt: existing };
    await col.insertOne(doc);
    return { created: true, attempt: doc };
  }
  const list = readJson("attempts.json", []);
  const existing = list.find(a => a.registrationId === registrationId);
  if (existing) return { created: false, attempt: existing };
  list.push(doc);
  writeJson("attempts.json", list);
  return { created: true, attempt: doc };
}

async function updateSubmission(registrationId, driveLink, now) {
  if (IS_MONGO) {
    const col = (await db()).collection("attempts");
    const existing = await col.findOne({ registrationId }, { projection: { _id: 0 } });
    if (!existing) return null;
    // Poora submission object set karo (submission null ho toh dotted $set fail hota tha).
    const submission = {
      ...(existing.submission || {}),
      driveLink,
      updatedAt: now,
    };
    if (!submission.submittedAt) submission.submittedAt = now;
    await col.updateOne({ registrationId }, { $set: { submission } });
    return col.findOne({ registrationId }, { projection: { _id: 0 } });
  }
  const list = readJson("attempts.json", []);
  const attempt = list.find(a => a.registrationId === registrationId);
  if (!attempt) return null;
  if (!attempt.submission) attempt.submission = {};
  if (!attempt.submission.submittedAt) attempt.submission.submittedAt = now;
  attempt.submission.driveLink = driveLink;
  attempt.submission.updatedAt = now;
  writeJson("attempts.json", list);
  return attempt;
}

async function resetAttempt(registrationId) {
  if (IS_MONGO) {
    await (await db()).collection("attempts").deleteOne({ registrationId });
    return true;
  }
  const list = readJson("attempts.json", []);
  const remaining = list.filter(a => a.registrationId !== registrationId);
  writeJson("attempts.json", remaining);
  return true;
}

async function extendAttempt(registrationId, extraMinutes) {
  const ms = extraMinutes * 60 * 1000;
  if (IS_MONGO) {
    const col = (await db()).collection("attempts");
    const doc = await col.findOne({ registrationId }, { projection: { _id: 0 } });
    if (!doc) return null;
    const newEnd = new Date(new Date(doc.endsAt).getTime() + ms).toISOString();
    await col.updateOne({ registrationId }, { $set: { endsAt: newEnd } });
    return col.findOne({ registrationId }, { projection: { _id: 0 } });
  }
  const list = readJson("attempts.json", []);
  const attempt = list.find(a => a.registrationId === registrationId);
  if (!attempt) return null;
  attempt.endsAt = new Date(new Date(attempt.endsAt).getTime() + ms).toISOString();
  writeJson("attempts.json", list);
  return attempt;
}

// ─── Login Attempts (rate limiting) ──────────────────────────────────────────

async function getLoginAttempt(key) {
  if (IS_MONGO) {
    return (await db()).collection("loginAttempts").findOne({ key }, { projection: { _id: 0 } });
  }
  return readJson("loginAttempts.json", []).find(a => a.key === key) || null;
}

async function upsertLoginAttempt(key, count, windowStart) {
  const doc = { key, count, windowStart };
  if (IS_MONGO) {
    await (await db()).collection("loginAttempts").replaceOne({ key }, doc, { upsert: true });
    return;
  }
  const list = readJson("loginAttempts.json", []);
  const idx = list.findIndex(a => a.key === key);
  if (idx >= 0) list[idx] = doc; else list.push(doc);
  writeJson("loginAttempts.json", list);
}

// ─── Results ─────────────────────────────────────────────────────────────────

const RESULTS_DEFAULTS = { first: null, second: null, third: null, published: false, publishedAt: null };

async function getResults() {
  if (IS_MONGO) {
    const doc = await (await db()).collection("results").findOne({}, { projection: { _id: 0 } });
    return { ...RESULTS_DEFAULTS, ...(doc || {}) };
  }
  return { ...RESULTS_DEFAULTS, ...readJson("results.json", {}) };
}

async function saveResults(patch) {
  const current = await getResults();
  const updated = { ...current, ...patch, updatedAt: new Date().toISOString() };
  if (IS_MONGO) {
    await (await db()).collection("results").replaceOne({}, updated, { upsert: true });
    return updated;
  }
  writeJson("results.json", updated);
  return updated;
}

// ─── Reviews ─────────────────────────────────────────────────────────────────

async function getReview(registrationId) {
  if (IS_MONGO) {
    return (await db()).collection("reviews").findOne({ registrationId }, { projection: { _id: 0 } });
  }
  return readJson("reviews.json", []).find(r => r.registrationId === registrationId) || null;
}

async function saveReview(registrationId, patch) {
  const existing = (await getReview(registrationId)) || { registrationId };
  const updated = { ...existing, ...patch, registrationId, updatedAt: new Date().toISOString() };
  if (IS_MONGO) {
    await (await db()).collection("reviews").replaceOne({ registrationId }, updated, { upsert: true });
    return updated;
  }
  const list = readJson("reviews.json", []);
  const idx = list.findIndex(r => r.registrationId === registrationId);
  if (idx >= 0) list[idx] = updated; else list.push(updated);
  writeJson("reviews.json", list);
  return updated;
}

async function getAllReviews() {
  if (IS_MONGO) {
    return (await db()).collection("reviews").find({}, { projection: { _id: 0 } }).toArray();
  }
  return readJson("reviews.json", []);
}

module.exports = {
  // registrations
  getAllRegistrations,
  getRegistration,
  findRegistrationByMemberId,
  createRegistration,
  updateRegistrationStatus,
  setRegistrationVenue,
  deleteRegistration,
  // receipts
  saveReceipt,
  getReceipt,
  deleteReceiptByRegistration,
  // settings
  getSettings,
  saveSettings,
  // attempts
  getAttempt,
  getAllAttempts,
  createAttempt,
  updateSubmission,
  resetAttempt,
  extendAttempt,
  // login attempts
  getLoginAttempt,
  upsertLoginAttempt,
  // results
  getResults,
  saveResults,
  // reviews
  getReview,
  saveReview,
  getAllReviews,
};
