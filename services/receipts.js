/**
 * services/receipts.js — Receipt file validation by magic bytes.
 * Validates file type from actual binary content, not just the extension or MIME type.
 * Supported: JPEG, PNG, PDF. Max size: 2 MB.
 */

const MAX_SIZE = 2 * 1024 * 1024; // 2 MB

/**
 * Magic byte signatures for supported file types.
 * Each entry has a `bytes` array (values to match) and an offset.
 */
const SIGNATURES = [
  { type: "image/jpeg",       mime: "image/jpeg",       bytes: [0xFF, 0xD8, 0xFF],       offset: 0 },
  { type: "image/png",        mime: "image/png",        bytes: [0x89, 0x50, 0x4E, 0x47], offset: 0 },
  { type: "application/pdf",  mime: "application/pdf",  bytes: [0x25, 0x50, 0x44, 0x46], offset: 0 }, // %PDF
];

/**
 * Determine file type from magic bytes.
 * Returns the matching signature object or null.
 */
function detectType(buffer) {
  for (const sig of SIGNATURES) {
    const slice = buffer.slice(sig.offset, sig.offset + sig.bytes.length);
    if (sig.bytes.every((b, i) => slice[i] === b)) return sig;
  }
  return null;
}

/**
 * Validate a receipt buffer.
 * Returns { ok: true, contentType } or { ok: false, error: string }.
 */
function validateReceipt(buffer) {
  if (!buffer || buffer.length === 0) {
    return { ok: false, error: "No file received." };
  }
  if (buffer.length > MAX_SIZE) {
    return { ok: false, error: "File is too large. Maximum size is 2 MB." };
  }
  const sig = detectType(buffer);
  if (!sig) {
    return { ok: false, error: "Only JPEG, PNG or PDF files are accepted." };
  }
  return { ok: true, contentType: sig.mime };
}

module.exports = { validateReceipt, MAX_SIZE };
