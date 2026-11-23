/**
 * admin.js — Admin panel: login, 4 tabs (Registrations, Settings, Live, Results).
 * Token stored in sessionStorage; all API calls include Authorization: Bearer.
 */

/* ─── State & helpers ─────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
let token         = sessionStorage.getItem("vsparkAdminToken");
let registrations = [];
let liveData      = [];
let resultsData   = {};
let settings      = {};
let liveTimer     = null;
let pendingRejectId  = null;
let pendingVenueId   = null;
let pendingExtendId  = null;

/** Safe HTML escape. */
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-PK", {
    timeZone: "Asia/Karachi", dateStyle: "short", timeStyle: "medium",
  });
}

function fmtTimeShort(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-PK", {
    timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function statusBadge(s) {
  const map = {
    pending:  '<span class="badge badge--warn">Pending</span>',
    accepted: '<span class="badge badge--ok">Accepted</span>',
    rejected: '<span class="badge badge--danger">Rejected</span>',
  };
  return map[s] || `<span class="badge badge--muted">${esc(s)}</span>`;
}

/* ─── API helper ──────────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const isFormData = opts.body instanceof FormData;
  const headers = { Authorization: `Bearer ${token}` };
  if (!isFormData) headers["Content-Type"] = "application/json";

  const res = await fetch(path, { ...opts, headers });
  if (res.status === 401 && path !== "/api/admin/login") logout();
  return res;
}

/* ─── Auth ────────────────────────────────────────────────────────────────── */
function logout() {
  token = null;
  sessionStorage.removeItem("vsparkAdminToken");
  $("dashView").hidden = true;
  $("loginView").hidden = false;
  $("logoutBtn").hidden = true;
  if (liveTimer) clearInterval(liveTimer);
}

$("logoutBtn").addEventListener("click", logout);

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("loginError").hidden = true;
  $("loginSubmit").disabled = true;
  $("loginSubmit").textContent = "Logging in…";

  const res  = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: $("username").value, password: $("password").value }),
  });
  const data = await res.json();
  $("loginSubmit").disabled = false;
  $("loginSubmit").textContent = "Log In";
  if (!res.ok) {
    $("loginError").textContent = data.error;
    $("loginError").hidden = false;
    return;
  }
  token = data.token;
  sessionStorage.setItem("vsparkAdminToken", token);
  showDashboard();
});

/* ─── Dashboard ───────────────────────────────────────────────────────────── */
async function showDashboard() {
  $("loginView").hidden = true;
  $("dashView").hidden  = false;
  $("logoutBtn").hidden = false;
  await Promise.all([loadRegistrations(), loadSettings()]);
}

/* ─── Tabs ────────────────────────────────────────────────────────────────── */
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b  => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");
    $(btn.dataset.tab).classList.add("active");

    if (btn.dataset.tab === "tab-live")    loadLive();
    if (btn.dataset.tab === "tab-results") loadResults();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
   REGISTRATIONS TAB
══════════════════════════════════════════════════════════════════════════ */

async function loadRegistrations() {
  const res = await api("/api/admin/registrations");
  if (!res) return;
  registrations = await res.json();
  renderStats();
  renderRegs();
}

function renderStats() {
  const total    = registrations.length;
  const pending  = registrations.filter(r => resolveStatus(r) === "pending").length;
  const accepted = registrations.filter(r => resolveStatus(r) === "accepted").length;
  const rejected = registrations.filter(r => resolveStatus(r) === "rejected").length;
  const people   = registrations.reduce((s, r) => s + r.members.length, 0);
  $("stats").innerHTML = [
    [total,    "Teams"],
    [people,   "Participants"],
    [pending,  "Pending"],
    [accepted, "Accepted"],
    [rejected, "Rejected"],
    [`PKR ${(accepted * 1000).toLocaleString()}`, "Est. collection"],
  ].map(([v, l]) => `<div class="stat"><strong>${v}</strong><span>${l}</span></div>`).join("");
}

function resolveStatus(r) {
  return r.status || (r.paymentVerified ? "accepted" : "pending");
}

function filteredRegs() {
  const q      = $("search").value.toLowerCase().trim();
  const status = $("statusFilter").value;
  return registrations.filter(r => {
    const text = [r.id, r.teamName, r.email, r.phone, r.transactionId,
      ...r.members.flatMap(m => [m.name, m.regNo])].join(" ").toLowerCase();
    return (!q || text.includes(q)) && (!status || resolveStatus(r) === status);
  });
}

function renderRegs() {
  const list = filteredRegs().slice().reverse();
  $("regsEmpty").hidden = list.length > 0;
  $("regsRows").innerHTML = list.map(regRow).join("");
}

function regRow(r) {
  const st = resolveStatus(r);
  const members = r.members.map(m =>
    `<div class="member"><strong>${esc(m.name)}</strong> <code>${esc(m.regNo)}</code>
     <small>${esc(m.program || "")}</small></div>`).join("");

  return `<tr>
    <td><code>${esc(r.id)}</code></td>
    <td>${r.teamName ? `<div class="team">${esc(r.teamName)}</div>` : ""}${members}</td>
    <td>${esc(r.email)}<br/><small>${esc(r.phone)}</small></td>
    <td>${esc(r.paymentMethod)}<br/><small>${esc(r.transactionId)}</small><br/>
      <button class="link-btn btn--sm" style="font-size:.8rem; padding:2px 0;" data-receipt="${esc(r.id)}">View receipt</button>
    </td>
    <td>
      ${statusBadge(st)}
      ${st === "rejected" && r.rejectReason ? `<br/><small style="color:var(--muted)">${esc(r.rejectReason)}</small>` : ""}
      <br/>
      <div style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;">
        ${st !== "accepted" ? `<button class="btn btn--sm btn--ok" data-accept="${esc(r.id)}">Accept</button>` : ""}
        ${st !== "rejected" ? `<button class="btn btn--sm btn--danger" data-reject="${esc(r.id)}">Reject</button>` : ""}
        ${st === "rejected" || st === "accepted" ? `<button class="btn btn--sm btn--ghost" data-pend="${esc(r.id)}">Set Pending</button>` : ""}
      </div>
    </td>
    <td>
      <small>${esc(r.venue || "(default)")}</small><br/>
      <button class="link-btn" style="font-size:.8rem;" data-venue="${esc(r.id)}">Change</button>
    </td>
    <td><small class="nowrap">${fmtTime(r.createdAt)}</small></td>
    <td><button class="link-btn danger" data-delete="${esc(r.id)}">Delete</button></td>
  </tr>`;
}

/* ─── Registrations tab actions ───────────────────────────────────────────── */
$("regsRows").addEventListener("click", async e => {
  const accept  = e.target.dataset.accept;
  const reject  = e.target.dataset.reject;
  const pend    = e.target.dataset.pend;
  const del     = e.target.dataset.delete;
  const receipt = e.target.dataset.receipt;
  const venue   = e.target.dataset.venue;

  if (accept)  await setStatus(accept, "accepted");
  if (reject)  openRejectModal(reject);
  if (pend)    await setStatus(pend, "pending");
  if (del)     await deleteReg(del);
  if (receipt) openReceiptModal(receipt);
  if (venue)   openVenueModal(venue);
});

async function setStatus(id, status, rejectReason = "") {
  const res = await api(`/api/admin/registrations/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status, rejectReason }),
  });
  if (!res || !res.ok) return;
  const updated = await res.json();
  registrations = registrations.map(r => r.id === id ? { ...r, ...updated } : r);
  renderStats();
  renderRegs();
}

async function deleteReg(id) {
  if (!confirm(`Delete registration ${id}? This cannot be undone.`)) return;
  const res = await api(`/api/admin/registrations/${id}`, { method: "DELETE" });
  if (!res || !res.ok) return;
  registrations = registrations.filter(r => r.id !== id);
  renderStats();
  renderRegs();
}

/* Reject modal */
function openRejectModal(id) {
  pendingRejectId = id;
  $("rejectReason").value = "";
  $("rejectModal").hidden = false;
  $("rejectReason").focus();
}

$("rejectCancelBtn").addEventListener("click", () => { $("rejectModal").hidden = true; });
$("rejectConfirmBtn").addEventListener("click", async () => {
  if (!pendingRejectId) return;
  const reason = $("rejectReason").value.trim();
  await setStatus(pendingRejectId, "rejected", reason);
  $("rejectModal").hidden = true;
  pendingRejectId = null;
});

/* Receipt modal */
async function openReceiptModal(id) {
  $("receiptContent").innerHTML = "Loading…";
  $("receiptModalTitle").textContent = `Receipt — ${id}`;
  $("receiptModal").hidden = false;
  try {
    const res = await api(`/api/admin/registrations/${id}/receipt`);
    if (!res || !res.ok) { $("receiptContent").innerHTML = `<p class="muted">Could not load receipt.</p>`; return; }
    const type = res.headers.get("content-type") || "";
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    if (type.startsWith("image/")) {
      $("receiptContent").innerHTML = `<img src="${url}" class="receipt-preview" alt="Receipt" />`;
    } else {
      $("receiptContent").innerHTML = `<a href="${url}" target="_blank" class="btn btn--sm">Open PDF ↗</a>`;
    }
  } catch {
    $("receiptContent").innerHTML = `<p class="muted">Error loading receipt.</p>`;
  }
}

$("receiptCloseBtn").addEventListener("click", () => { $("receiptModal").hidden = true; });

/* Venue modal */
function openVenueModal(id) {
  pendingVenueId = id;
  const reg = registrations.find(r => r.id === id);
  $("venueInput").value = reg?.venue || "";
  $("venueModal").hidden = false;
  $("venueInput").focus();
}

$("venueCancelBtn").addEventListener("click", () => { $("venueModal").hidden = true; });
$("venueConfirmBtn").addEventListener("click", async () => {
  if (!pendingVenueId) return;
  const venue = $("venueInput").value.trim();
  const res = await api(`/api/admin/registrations/${pendingVenueId}/venue`, {
    method: "PATCH", body: JSON.stringify({ venue }),
  });
  if (res?.ok) {
    const updated = await res.json();
    registrations = registrations.map(r => r.id === pendingVenueId ? { ...r, ...updated } : r);
    renderRegs();
  }
  $("venueModal").hidden = true;
  pendingVenueId = null;
});

/* Search/filter */
[$("search"), $("statusFilter")].forEach(el => el.addEventListener("input", renderRegs));

/* Export */
$("exportBtn").addEventListener("click", async () => {
  const res = await api("/api/admin/export.csv");
  if (!res?.ok) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = "vspark-registrations.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ═══════════════════════════════════════════════════════════════════════════
   SETTINGS TAB
══════════════════════════════════════════════════════════════════════════ */

async function loadSettings() {
  const res = await api("/api/admin/settings");
  if (!res?.ok) return;
  settings = await res.json();
  applySettings();
}

function applySettings() {
  $("settingsDriveLink").value = settings.driveLink || "";
  $("settingsDuration").value  = settings.durationMinutes || 20;
  $("settingsVenue").value     = settings.defaultVenue || "";
  updateGateUI(settings.gateOpen);
}

function updateGateUI(isOpen) {
  $("gateStatus").textContent = isOpen ? "Open" : "Closed";
  $("gateStatus").className = "badge " + (isOpen ? "badge--ok" : "badge--warn");
  $("toggleGateBtn").textContent = isOpen ? "Close Gate" : "Open Gate";
}

$("settingsForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("settingsError").hidden = true;
  $("settingsDriveLinkErr").textContent = "";

  const driveLink      = $("settingsDriveLink").value.trim();
  const durationMinutes = parseInt($("settingsDuration").value, 10);
  const defaultVenue   = $("settingsVenue").value.trim();

  if (driveLink && !/^https:\/\/(drive|docs)\.google\.com\/.+/i.test(driveLink)) {
    $("settingsDriveLinkErr").textContent = "Must be a valid https://drive.google.com or docs.google.com URL.";
    return;
  }

  const res = await api("/api/admin/settings", {
    method: "PATCH", body: JSON.stringify({ driveLink, durationMinutes, defaultVenue }),
  });
  if (!res?.ok) {
    const data = await res.json();
    $("settingsError").textContent = data.error || "Could not save.";
    $("settingsError").hidden = false;
    return;
  }
  settings = await res.json();
  $("settingsSaved").hidden = false;
  setTimeout(() => ($("settingsSaved").hidden = true), 2500);
});

$("toggleGateBtn").addEventListener("click", async () => {
  const newState = !settings.gateOpen;
  if (!newState && !confirm("Close the gate? Teams already running are not affected — only new starts will be blocked.")) return;
  if (newState  && !confirm("Open the gate? Accepted participants will be able to start their timer.")) return;

  const res = await api("/api/admin/settings", {
    method: "PATCH", body: JSON.stringify({ gateOpen: newState }),
  });
  if (res?.ok) {
    settings = await res.json();
    updateGateUI(settings.gateOpen);
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
   LIVE TAB
══════════════════════════════════════════════════════════════════════════ */

async function loadLive() {
  const res = await api("/api/admin/live");
  if (!res?.ok) return;
  const data = await res.json();
  liveData = data.teams;
  renderLive();
  $("liveLastUpdated").textContent = `Updated ${new Date().toLocaleTimeString("en-PK", { timeZone: "Asia/Karachi" })}`;
  // Auto-refresh every 10 seconds while on this tab.
  if (liveTimer) clearInterval(liveTimer);
  liveTimer = setInterval(() => {
    if ($("tab-live").classList.contains("active")) loadLive();
    else { clearInterval(liveTimer); liveTimer = null; }
  }, 10000);
}

function filteredLive() {
  const q     = $("liveSearch").value.toLowerCase().trim();
  const state = $("liveStateFilter").value;
  return liveData.filter(t => {
    const text = [t.id, t.teamName, ...t.members.flatMap(m => [m.name, m.regNo])].join(" ").toLowerCase();
    return (!q || text.includes(q)) && (!state || t.state === state);
  });
}

function renderLive() {
  const list = filteredLive();
  $("liveEmpty").hidden = list.length > 0;
  $("liveRows").innerHTML = list.map(liveRow).join("");
}

function liveRow(t) {
  const stateHtml = {
    not_started: `<span class="live-state-not_started">Not started</span>`,
    running:     `<span class="live-state-running">Running ${fmtRemaining(t.remaining)}</span>`,
    time_over:   `<span class="live-state-time_over">Time over</span>`,
    submitted:   `<span class="live-state-submitted">Submitted ✓</span>`,
  }[t.state] || esc(t.state);

  const sub = t.submission;
  const subHtml = sub?.driveLink
    ? `<a href="${esc(sub.driveLink)}" target="_blank" rel="noopener" class="link-btn" style="font-size:.8rem;">Open ↗</a>`
    : `<span class="muted">—</span>`;

  const afterMins = sub?.submittedAt && t.startedAt
    ? Math.round((new Date(sub.submittedAt) - new Date(t.startedAt)) / 60000) + " min"
    : "—";

  const actions = t.state !== "not_started"
    ? `<button class="btn btn--sm btn--danger" data-reset="${esc(t.id)}" title="Reset attempt">Reset</button>
       <button class="btn btn--sm btn--ghost" data-extend="${esc(t.id)}" title="Add minutes">+Time</button>`
    : "";

  return `<tr>
    <td><code>${esc(t.id)}</code><br/><small class="team">${esc(t.teamName)}</small></td>
    <td>${t.members.map(m => `<div>${esc(m.name)} <code style="font-size:.75rem">${esc(m.regNo)}</code></div>`).join("")}</td>
    <td><small>${esc(t.venue || "(default)")}</small></td>
    <td>${stateHtml}</td>
    <td><small class="nowrap">${fmtTimeShort(t.startedAt)}</small></td>
    <td><small class="nowrap">${fmtTimeShort(t.endsAt)}</small></td>
    <td>${subHtml}</td>
    <td><small>${afterMins}</small></td>
    <td style="white-space:nowrap;">${actions}</td>
  </tr>`;
}

function fmtRemaining(ms) {
  if (!ms) return "";
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `(${m}:${String(s).padStart(2, "0")})`;
}

$("liveRows").addEventListener("click", async e => {
  const reset  = e.target.dataset.reset;
  const extend = e.target.dataset.extend;
  if (reset && confirm(`Reset attempt for ${reset}? They will be able to start again.`)) {
    const res = await api(`/api/admin/attempts/${reset}/reset`, { method: "POST" });
    if (res?.ok) loadLive();
  }
  if (extend) openExtendModal(extend);
});

function openExtendModal(id) {
  pendingExtendId = id;
  $("extendMinutes").value = "5";
  $("extendModal").hidden = false;
  $("extendMinutes").focus();
}
$("extendCancelBtn").addEventListener("click", () => { $("extendModal").hidden = true; });
$("extendConfirmBtn").addEventListener("click", async () => {
  const extra = parseInt($("extendMinutes").value, 10);
  if (!extra || extra < 1) return;
  const res = await api(`/api/admin/attempts/${pendingExtendId}/extend`, {
    method: "PATCH", body: JSON.stringify({ extraMinutes: extra }),
  });
  if (res?.ok) loadLive();
  $("extendModal").hidden = true;
  pendingExtendId = null;
});

[$("liveSearch"), $("liveStateFilter")].forEach(el => el.addEventListener("input", renderLive));
$("liveRefreshBtn").addEventListener("click", loadLive);

$("liveExportBtn").addEventListener("click", () => {
  const header = ["Team ID", "Team Name", "M1 Name", "M1 Reg No", "M2 Name", "M2 Reg No",
                  "Venue", "State", "Started At", "Ends At", "Drive Link", "Submitted At", "Min After Start"];
  const rows = filteredLive().map(t => {
    const [m1 = {}, m2 = {}] = t.members;
    const sub = t.submission;
    const afterMins = sub?.submittedAt && t.startedAt
      ? Math.round((new Date(sub.submittedAt) - new Date(t.startedAt)) / 60000) : "";
    return [
      t.id, t.teamName, m1.name, m1.regNo, m2.name || "", m2.regNo || "",
      t.venue || "", t.state, t.startedAt || "", t.endsAt || "",
      sub?.driveLink || "", sub?.submittedAt || "", afterMins,
    ].map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",");
  });
  downloadCsv([header.join(","), ...rows].join("\n"), "vspark-live.csv");
});

/* ═══════════════════════════════════════════════════════════════════════════
   RESULTS TAB
══════════════════════════════════════════════════════════════════════════ */

async function loadResults() {
  const res = await api("/api/admin/results");
  if (!res?.ok) return;
  resultsData = await res.json();
  renderResults();
}

function renderResults() {
  const { withSubmission = [], withoutSubmission = [], results = {}, reviewedCount = 0, totalSubmissions = 0 } = resultsData;

  // Podium
  const posMap = { first: "podiumFirst", second: "podiumSecond", third: "podiumThird" };
  for (const [key, elId] of Object.entries(posMap)) {
    const id  = results[key];
    const team = id ? withSubmission.find(t => t.id === id) : null;
    $(elId).innerHTML = team
      ? `<div class="podium-team">${esc(team.teamName)}</div>`
      : `<div class="podium-empty">Not decided</div>`;
  }

  // Publish controls.
  const pub = results.published;
  $("publishBtn").hidden   = pub;
  $("unpublishBtn").hidden = !pub;
  $("publishedBadge").hidden = !pub;

  // Review progress.
  const pct = totalSubmissions > 0 ? Math.round((reviewedCount / totalSubmissions) * 100) : 0;
  $("reviewProgress").style.width      = pct + "%";
  $("reviewProgressLabel").textContent = `${reviewedCount} of ${totalSubmissions} reviewed`;

  // Submissions table.
  const q   = $("resultsSearch").value.toLowerCase().trim();
  const sub = withSubmission.filter(t =>
    !q || [t.id, t.teamName, ...t.members.flatMap(m => [m.name, m.regNo])].join(" ").toLowerCase().includes(q)
  );
  $("resultsEmpty").hidden = sub.length > 0;
  $("resultsRows").innerHTML = sub.map(t => resultRow(t, results)).join("");

  // No-submission table.
  $("noSubEmpty").hidden = withoutSubmission.length > 0;
  $("noSubRows").innerHTML = withoutSubmission.map(t => `<tr>
    <td><code>${esc(t.id)}</code> <span class="team">${esc(t.teamName)}</span></td>
    <td>${t.members.map(m => `${esc(m.name)} <code style="font-size:.75rem">${esc(m.regNo)}</code>`).join("<br/>")}</td>
    <td><small>${esc(t.venue || "")}</small></td>
    <td><small>${fmtTimeShort(t.startedAt)}</small></td>
  </tr>`).join("");
}

function resultRow(t, results) {
  const posOptions = `
    <option value="">None</option>
    <option value="1" ${results.first  === t.id ? "selected" : ""}>1st</option>
    <option value="2" ${results.second === t.id ? "selected" : ""}>2nd</option>
    <option value="3" ${results.third  === t.id ? "selected" : ""}>3rd</option>`;

  return `<tr>
    <td><code>${esc(t.id)}</code><br/><span class="team">${esc(t.teamName)}</span></td>
    <td>${t.members.map(m => `<div>${esc(m.name)} <code style="font-size:.75rem">${esc(m.regNo)}</code></div>`).join("")}</td>
    <td><small>${esc(t.venue || "")}</small></td>
    <td><a href="${esc(t.submission.driveLink)}" target="_blank" rel="noopener" class="link-btn" style="font-size:.8rem;">Open ↗</a></td>
    <td><small class="nowrap">${fmtTimeShort(t.submission.submittedAt)}</small></td>
    <td><small>${t.submittedAfterMinutes} min</small></td>
    <td>
      <select data-position="${esc(t.id)}" style="width:auto; padding:6px 10px; font-size:.85rem;">${posOptions}</select>
    </td>
    <td>
      <label style="display:flex; align-items:center; gap:6px; cursor:pointer;">
        <input type="checkbox" data-reviewed="${esc(t.id)}" ${t.reviewed ? "checked" : ""} />
        <span style="font-size:.82rem;">Reviewed</span>
      </label>
    </td>
    <td>
      <textarea data-notes="${esc(t.id)}" rows="2" style="width:200px; font-size:.8rem;" maxlength="500"
        placeholder="Private judge notes…">${esc(t.notes)}</textarea>
    </td>
  </tr>`;
}

/* Results tab actions */
document.addEventListener("change", async e => {
  const posId   = e.target.dataset.position;
  const revId   = e.target.dataset.reviewed;
  if (posId !== undefined) await assignPosition(posId, e.target.value);
  if (revId !== undefined) await saveReview(revId, { reviewed: e.target.checked });
});

document.addEventListener("blur", async e => {
  const notesId = e.target.dataset.notes;
  if (notesId !== undefined) {
    await saveReview(notesId, { notes: e.target.value });
  }
}, true);

async function assignPosition(registrationId, position) {
  const body = { registrationId, position: position ? Number(position) : null };
  const res  = await api("/api/admin/results/position", { method: "PATCH", body: JSON.stringify(body) });
  if (!res) return;

  if (res.status === 409) {
    const data = await res.json();
    if (confirm(`${data.message || "Replace?"}`)) {
      await api("/api/admin/results/position", {
        method: "PATCH", body: JSON.stringify({ ...body, force: true }),
      });
    }
    // Reload to show correct state either way.
    await loadResults();
    return;
  }

  if (!res.ok) {
    const data = await res.json();
    alert(data.error || "Could not update position.");
    await loadResults();
    return;
  }
  resultsData.results = await res.json();
  renderResults();
}

async function saveReview(registrationId, patch) {
  const res = await api(`/api/admin/results/review/${registrationId}`, {
    method: "PATCH", body: JSON.stringify(patch),
  });
  if (res?.ok) {
    // Update in-place so the progress counter stays current.
    const updated = await res.json();
    if (resultsData.withSubmission) {
      const idx = resultsData.withSubmission.findIndex(t => t.id === registrationId);
      if (idx >= 0) {
        resultsData.withSubmission[idx] = { ...resultsData.withSubmission[idx], ...patch };
        resultsData.reviewedCount = resultsData.withSubmission.filter(t => t.reviewed).length;
      }
    }
    renderResults();
  }
}

$("publishBtn").addEventListener("click", async () => {
  if (!confirm("Publish results? The winners will appear on the landing page and in participants' portals.")) return;
  const res = await api("/api/admin/results/publish", { method: "POST" });
  if (!res?.ok) {
    const d = await res.json();
    alert(d.error || "Could not publish.");
    return;
  }
  resultsData.results = await res.json();
  renderResults();
});

$("unpublishBtn").addEventListener("click", async () => {
  if (!confirm("Unpublish results? Winners will be hidden until you publish again.")) return;
  const res = await api("/api/admin/results/unpublish", { method: "POST" });
  if (res?.ok) { resultsData.results = await res.json(); renderResults(); }
});

$("resultsSearch").addEventListener("input", renderResults);

$("resultsExportBtn").addEventListener("click", async () => {
  const res = await api("/api/admin/results/export.csv");
  if (!res?.ok) return;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = "vspark-results.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});

/* ─── Utility ─────────────────────────────────────────────────────────────── */
function downloadCsv(content, filename) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "text/csv" }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ─── Bootstrap ───────────────────────────────────────────────────────────── */
if (token) showDashboard();
