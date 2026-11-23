/**
 * register.js — Registration form: dropdowns, validation, file preview, multipart submit.
 * All fields are re-validated on the server; this is a convenience layer only.
 */

/* ─── Regex (must match server) ─── */
const COMSATS_REG_NO = /^(FA|SP)\d{2}-[A-Z]{2,4}-\d{3}$/;
const EMAIL          = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE          = /^03\d{9}$/;
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

/* ─── DOM refs ─── */
const form      = document.getElementById("form");
const submitBtn = document.getElementById("submitBtn");
const formError = document.getElementById("formError");
const success   = document.getElementById("success");

// ─── Populate program dropdown ─────────────────────────────────────────────

async function loadOptions() {
  try {
    const res  = await fetch("/api/options");
    const data = await res.json();
    [1, 2].forEach(n => {
      const sel = form.elements[`member${n}Program`];
      sel.innerHTML = '<option value="">Choose program</option>' +
        data.programs.map(p => `<option>${escapeHtml(p)}</option>`).join("");
    });
  } catch {
    console.warn("Could not load options.");
  }
}

// ─── Error helpers ────────────────────────────────────────────────────────

function setError(name, message) {
  const hint  = form.querySelector(`.error[data-for="${name}"]`);
  const input = form.elements[name];
  if (hint)  hint.textContent  = message || "";
  if (input) input.setAttribute("aria-invalid", message ? "true" : "false");
}

function clearErrors() {
  formError.hidden = true;
  form.querySelectorAll(".error").forEach(el => (el.textContent = ""));
  [...form.elements].forEach(el => el.removeAttribute("aria-invalid"));
}

function showErrors(errors) {
  Object.entries(errors).forEach(([name, msg]) => setError(name, msg));
  form.querySelector('[aria-invalid="true"]')?.focus();
}

// ─── Client-side validation (server always re-checks) ─────────────────────

function validateForm(values, file) {
  const errors = {};

  const checkMember = n => {
    const name    = (values[`member${n}Name`] || "").trim();
    const regNo   = (values[`member${n}RegNo`] || "").toUpperCase().trim();
    const program = values[`member${n}Program`] || "";
    if (name.length < 3)              errors[`member${n}Name`]    = "Enter the full name.";
    if (!COMSATS_REG_NO.test(regNo))  errors[`member${n}RegNo`]   = "Use the format FA23-BSE-062.";
    if (!program)                     errors[`member${n}Program`] = "Choose a degree program.";
  };

  checkMember(1);
  const hasM2 = (values.member2Name || "").trim() || (values.member2RegNo || "").trim() || values.member2Program;
  if (hasM2) {
    checkMember(2);
    const r1 = (values.member1RegNo || "").toUpperCase().trim();
    const r2 = (values.member2RegNo || "").toUpperCase().trim();
    if (!errors.member2RegNo && r1 && r2 && r1 === r2)
      errors.member2RegNo = "Teammate must be a different person.";
  }

  if (!EMAIL.test((values.email || "").trim()))  errors.email = "Enter a valid email address.";
  if (!PHONE.test((values.phone || "").trim()))  errors.phone = "Use the format 03001234567.";
  if (!values.paymentMethod)   errors.paymentMethod = "Choose a payment method.";
  if ((values.transactionId || "").trim().length < 4) errors.transactionId = "Enter the transaction ID.";

  if (!file) {
    errors.receipt = "Payment receipt is required.";
  } else if (file.size > MAX_FILE_BYTES) {
    errors.receipt = "File is too large. Maximum size is 2 MB.";
  } else if (!["image/jpeg", "image/png", "application/pdf"].includes(file.type)) {
    errors.receipt = "Only JPG, PNG or PDF files are accepted.";
  }

  return errors;
}

// ─── Input formatting ──────────────────────────────────────────────────────

form.querySelectorAll("[data-regno]").forEach(input => {
  input.addEventListener("input", () => {
    input.value = input.value.toUpperCase().replace(/\s/g, "");
  });
});
form.elements.phone.addEventListener("input", e => {
  e.target.value = e.target.value.replace(/\D/g, "");
});

// ─── Receipt file preview ─────────────────────────────────────────────────

const uploadArea    = document.getElementById("uploadArea");
const uploadPrompt  = document.getElementById("uploadPrompt");
const uploadPreview = document.getElementById("uploadPreview");
const receiptInput  = document.getElementById("receipt");

function showReceiptPreview(file) {
  if (!file) return;
  uploadPrompt.hidden  = true;
  uploadPreview.hidden = false;
  if (file.type.startsWith("image/")) {
    const reader = new FileReader();
    reader.onload = e => {
      uploadPreview.innerHTML = `
        <div style="margin-bottom:8px; font-size:.88rem; color:var(--ok)">✓ ${escapeHtml(file.name)} (${(file.size/1024).toFixed(0)} KB)</div>
        <img src="${e.target.result}" alt="Receipt preview" class="receipt-preview" />`;
    };
    reader.readAsDataURL(file);
  } else {
    uploadPreview.innerHTML = `
      <div style="font-size:2rem; margin-bottom:8px;">📄</div>
      <div style="font-size:.88rem; color:var(--ok)">✓ ${escapeHtml(file.name)} (${(file.size/1024).toFixed(0)} KB)</div>`;
  }
}

receiptInput.addEventListener("change", () => {
  if (receiptInput.files[0]) showReceiptPreview(receiptInput.files[0]);
});

// Drag & drop.
uploadArea.addEventListener("dragover", e => { e.preventDefault(); uploadArea.classList.add("dragover"); });
uploadArea.addEventListener("dragleave", () => uploadArea.classList.remove("dragover"));
uploadArea.addEventListener("drop", e => {
  e.preventDefault();
  uploadArea.classList.remove("dragover");
  const file = e.dataTransfer.files[0];
  if (file) {
    // Assign to file input (create a DataTransfer to set files).
    const dt = new DataTransfer();
    dt.items.add(file);
    receiptInput.files = dt.files;
    showReceiptPreview(file);
  }
});

// ─── Submit ───────────────────────────────────────────────────────────────

form.addEventListener("submit", async e => {
  e.preventDefault();
  clearErrors();

  const values = Object.fromEntries(new FormData(form));
  const file   = receiptInput.files[0] || null;
  const errors = validateForm(values, file);
  if (Object.keys(errors).length) return showErrors(errors);

  submitBtn.disabled    = true;
  submitBtn.textContent = "Submitting…";

  try {
    // Build multipart/form-data payload.
    const fd = new FormData(form); // already contains the file input

    const res  = await fetch("/api/register", { method: "POST", body: fd });
    const data = await res.json();

    if (!res.ok) {
      showErrors(data.errors || {});
      if (!data.errors) {
        formError.textContent = data.error || "Registration failed. Please try again.";
        formError.hidden = false;
      }
      return;
    }

    // Show the Registration ID. Portal login requires it.
    const regId = data.id;
    document.getElementById("regId").textContent = regId;
    document.getElementById("portalLink").href = "/portal?id=" + encodeURIComponent(regId);
    form.hidden = true;
    document.getElementById("form-title").hidden = true;
    document.getElementById("formIntro").hidden = true;
    success.hidden = false;
    success.focus();
    success.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    formError.textContent = "Couldn't reach the server. Check your connection and try again.";
    formError.hidden = false;
  } finally {
    submitBtn.disabled    = false;
    submitBtn.textContent = "Submit Registration";
  }
});

// ─── Utility ─────────────────────────────────────────────────────────────

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

document.getElementById("copyIdBtn").addEventListener("click", async () => {
  const id = document.getElementById("regId").textContent.trim();
  if (!id) return;
  try {
    await navigator.clipboard.writeText(id);
  } catch {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById("regId"));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }
  document.getElementById("copyIdMsg").hidden = false;
});

loadOptions();
