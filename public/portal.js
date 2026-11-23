/**
 * portal.js — Participant portal JS.
 * Handles login, status display, competition start, countdown and submission.
 * ALL time decisions are made on the server; the client only displays.
 */

/* ─── State ─── */
let token = sessionStorage.getItem("vsparkPortalToken");
let clockOffset = 0;      // serverNow - Date.now() at last sync
let countdownTimer = null; // setInterval handle
let resyncTimer   = null;  // setInterval for server clock re-sync (~30s)
let gatePoller    = null;  // poll when gate is closed

const $ = id => document.getElementById(id);

/* ─── Screens ─────────────────────────────────────────────────────────────── */
const screens = ["loginView", "portalView"];
function showScreen(id) {
  screens.forEach(s => $(s).hidden = s !== id);
}

const accepted = ["screenPending", "screenRejected", "screenAccepted"];
function showStatus(id) {
  accepted.forEach(s => $(s).hidden = s !== id);
}

const compScreens = ["screenGateClosed", "screenReadyToStart", "screenRunning", "screenTimeOver"];
function showCompScreen(id) {
  compScreens.forEach(s => $(s).hidden = s !== id);
}

/* ─── API helper ─────────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (res.status === 401) return logout(), null;
  return res;
}

/* ─── Auth ───────────────────────────────────────────────────────────────── */
function logout() {
  token = null;
  sessionStorage.removeItem("vsparkPortalToken");
  clearTimers();
  showScreen("loginView");
  $("logoutBtn").hidden = true;
}

$("logoutBtn").addEventListener("click", logout);

const prefilledId = new URLSearchParams(location.search).get("id");
if (prefilledId) $("loginId").value = prefilledId.toUpperCase();

$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("loginError").hidden = true;
  $("loginSubmit").disabled = true;
  $("loginSubmit").textContent = "Logging in…";

  const id    = $("loginId").value.trim().toUpperCase();
  const regNo = $("loginRegNo").value.trim().toUpperCase();

  try {
    const res  = await fetch("/api/portal/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ registrationId: id, regNo }),
    });
    const data = await res.json();
    if (!res.ok) {
      $("loginError").textContent = data.error || "Login failed.";
      $("loginError").hidden = false;
      return;
    }
    token = data.token;
    sessionStorage.setItem("vsparkPortalToken", token);
    await loadPortal();
  } catch {
    $("loginError").textContent = "Couldn't reach the server. Try again.";
    $("loginError").hidden = false;
  } finally {
    $("loginSubmit").disabled = false;
    $("loginSubmit").textContent = "Log In";
  }
});

/* ─── Load portal ────────────────────────────────────────────────────────── */
async function loadPortal() {
  const res = await api("/api/portal/me");
  if (!res) return;
  const reg = await res.json();

  showScreen("portalView");
  $("logoutBtn").hidden = false;

  const status = reg.status;

  if (status === "pending") {
    showStatus("screenPending");
    renderTeamInfo("pendingTeamInfo", reg);
    return;
  }

  if (status === "rejected") {
    showStatus("screenRejected");
    if (reg.rejectReason) {
      $("rejectReasonText").textContent = `Reason: ${reg.rejectReason}`;
      $("rejectReasonText").hidden = false;
    }
    return;
  }

  // Accepted.
  showStatus("screenAccepted");
  $("acceptedTeamName").textContent = reg.teamName || reg.members[0].name;
  $("acceptedRegId").textContent = `Registration ID: ${reg.id}`;
  $("acceptedMembers").innerHTML = reg.members
    .map(m => `<span>${esc(m.name)} · <code>${esc(m.regNo)}</code> · ${esc(m.program)}</span>`)
    .join("<br/>");

  if (reg.venue) {
    $("venueBlock").hidden = false;
    $("venueName").textContent = reg.venue;
  }

  // Show result card if published.
  if (reg.result !== null) {
    renderResult(reg.result);
  }

  // Load competition state.
  await loadCompetition();
}

function renderTeamInfo(containerId, reg) {
  $(containerId).innerHTML = `
    <strong>${esc(reg.teamName || reg.members[0].name)}</strong><br/>
    <span class="muted" style="font-size:.88rem;">
      ${reg.members.map(m => `${esc(m.name)} · ${esc(m.regNo)}`).join(" &amp; ")}
    </span>
    <p class="muted" style="font-size:.82rem; margin:8px 0 0;">Registration ID: <code>${esc(reg.id)}</code></p>`;
}

function renderResult(position) {
  const card    = $("resultCard");
  const heading = $("resultHeading");
  const text    = $("resultText");
  card.hidden = false;

  if (position === 1) {
    heading.textContent = "🥇 1st Place";
    text.textContent = "Congratulations! You secured 1st place in the VSPARK competition.";
  } else if (position === 2) {
    heading.textContent = "🥈 2nd Place";
    text.textContent = "Congratulations! You secured 2nd place in the VSPARK competition.";
  } else if (position === 3) {
    heading.textContent = "🥉 3rd Place";
    text.textContent = "Congratulations! You secured 3rd place in the VSPARK competition.";
  } else {
    heading.textContent = "Thank you for participating!";
    text.textContent = "Results have been published. Keep building — we hope to see you next time!";
  }
}

/* ─── Competition ─────────────────────────────────────────────────────────── */
async function loadCompetition() {
  // Check if attempt already exists.
  const res = await api("/api/portal/attempt");
  if (!res) return;
  const { attempt, serverNow } = await res.json();

  if (serverNow) calibrateClock(serverNow);

  if (!attempt) {
    // No attempt yet — check if gate is open.
    await checkGate();
    return;
  }

  // Attempt exists — render it.
  renderAttempt(attempt);
}

async function checkGate() {
  const res = await api("/api/portal/settings");
  if (!res) return;
  const { gateOpen } = await res.json();

  if (gateOpen) {
    showCompScreen("screenReadyToStart");
    clearPoller();
  } else {
    showCompScreen("screenGateClosed");
    // Poll every 15 seconds for gate to open.
    if (!gatePoller) {
      gatePoller = setInterval(async () => {
        const r = await api("/api/portal/settings");
        if (!r) return;
        const s = await r.json();
        if (s.gateOpen) {
          clearPoller();
          showCompScreen("screenReadyToStart");
        }
      }, 15000);
    }
  }
}

/* Start button */
$("startBtn").addEventListener("click", async () => {
  if (!confirm("Start your 20-minute competition window now?\n\nThe timer starts immediately and cannot be paused. Make sure you are ready.")) return;

  $("startBtn").disabled = true;
  $("startBtn").textContent = "Starting…";
  try {
    const res = await api("/api/portal/start", { method: "POST" });
    if (!res) return;
    const data = await res.json();
    if (!res.ok) {
      alert(data.error || "Could not start. Please try again.");
      return;
    }
    renderAttempt(data.attempt);
  } catch {
    alert("Network error. Please try again.");
  } finally {
    $("startBtn").disabled = false;
    $("startBtn").textContent = "Start My 20 Minutes →";
  }
});

/* Render an attempt object (running or time over). */
function renderAttempt(attempt) {
  if (attempt.timeOver) {
    showCompScreen("screenTimeOver");
    renderFinalSubmission(attempt.submission);
  } else {
    showCompScreen("screenRunning");
    if (attempt.adminDriveLink) {
      $("adminDriveLink").href = attempt.adminDriveLink;
      $("driveLinkCard").hidden = false;
    }
    renderExistingSubmission(attempt.submission);
    startCountdown(attempt.endsAt);
    scheduleResync();
  }
}

function renderExistingSubmission(sub) {
  if (sub?.driveLink) {
    $("submissionLink").value = sub.driveLink;
    showSubmitStatus(`Last submitted at ${formatPkTime(sub.updatedAt || sub.submittedAt)}`);
  }
}

function renderFinalSubmission(sub) {
  const el = $("finalSubmissionView");
  if (sub?.driveLink) {
    el.innerHTML = `
      <p class="muted">Your submission:</p>
      <a href="${esc(sub.driveLink)}" target="_blank" rel="noopener" class="btn btn--ghost btn--sm">Open submitted link ↗</a>
      <p class="muted" style="font-size:.82rem; margin-top:8px;">Submitted at ${esc(formatPkTime(sub.submittedAt))}</p>`;
  } else {
    el.innerHTML = `<p class="muted">You did not submit anything.</p>`;
  }
}

/* ─── Countdown ──────────────────────────────────────────────────────────── */
function startCountdown(endsAtIso) {
  clearTimers();
  const endsAt = new Date(endsAtIso).getTime();

  function tick() {
    const remaining = endsAt - serverNow();
    if (remaining <= 0) {
      $("countdown").textContent = "00:00";
      $("countdown").className   = "countdown-time done";
      clearTimers();
      // Switch to time-over screen.
      $("submitForm").querySelectorAll("input, button").forEach(el => (el.disabled = true));
      showCompScreen("screenTimeOver");
      // Fetch final attempt state.
      api("/api/portal/attempt").then(r => r && r.json()).then(d => {
        if (d?.attempt) renderFinalSubmission(d.attempt.submission);
      });
      return;
    }
    const mins = Math.floor(remaining / 60000);
    const secs = Math.floor((remaining % 60000) / 1000);
    $("countdown").textContent = `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    // Colour coding.
    $("countdown").className = remaining < 2 * 60000
      ? "countdown-time danger"
      : remaining < 5 * 60000
        ? "countdown-time warning"
        : "countdown-time";
  }

  tick();
  countdownTimer = setInterval(tick, 500);

  // Show endsAt in PKT.
  $("endsAtDisplay").textContent = formatPkTime(endsAtIso);
}

/* ─── Clock sync ─────────────────────────────────────────────────────────── */
function calibrateClock(serverNowMs) {
  clockOffset = serverNowMs - Date.now();
}

function serverNow() {
  return Date.now() + clockOffset;
}

function scheduleResync() {
  if (resyncTimer) clearInterval(resyncTimer);
  resyncTimer = setInterval(async () => {
    try {
      const res = await fetch("/api/public/servertime");
      const { now } = await res.json();
      calibrateClock(now);
      // Also refresh the Drive link in case it changed.
      const r = await api("/api/portal/attempt");
      if (r) {
        const { attempt } = await r.json();
        if (attempt?.adminDriveLink) {
          $("adminDriveLink").href = attempt.adminDriveLink;
          $("driveLinkCard").hidden = false;
        }
      }
    } catch { /* ignore */ }
  }, 30000);
}

/* ─── Submission form ────────────────────────────────────────────────────── */
const DRIVE_URL = /^https:\/\/(drive|docs)\.google\.com\/.+/i;

$("submitForm").addEventListener("submit", async e => {
  e.preventDefault();
  const link = $("submissionLink").value.trim();
  $("submitLinkError").textContent = "";

  if (!DRIVE_URL.test(link)) {
    $("submitLinkError").textContent = "Enter a valid https://drive.google.com or https://docs.google.com URL.";
    return;
  }

  $("submitLinkBtn").disabled    = true;
  $("submitLinkBtn").textContent = "Submitting…";

  try {
    const res  = await api("/api/portal/submit", {
      method: "POST",
      body: JSON.stringify({ driveLink: link }),
    });
    if (!res) return;
    const data = await res.json();
    if (!res.ok) {
      $("submitLinkError").textContent = data.error || "Submission failed.";
      return;
    }
    showSubmitStatus(`Submitted at ${formatPkTime(data.attempt?.submission?.updatedAt || new Date().toISOString())}`);
  } catch {
    $("submitLinkError").textContent = "Network error. Please try again.";
  } finally {
    $("submitLinkBtn").disabled    = false;
    $("submitLinkBtn").textContent = "Submit Link";
  }
});

function showSubmitStatus(msg) {
  const el = $("submitStatus");
  el.hidden = false;
  el.innerHTML = `✓ ${esc(msg)}`;
}

/* ─── Helpers ────────────────────────────────────────────────────────────── */
function clearTimers() {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  if (resyncTimer)    { clearInterval(resyncTimer);    resyncTimer    = null; }
}

function clearPoller() {
  if (gatePoller) { clearInterval(gatePoller); gatePoller = null; }
}

function formatPkTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-PK", {
    timeZone: "Asia/Karachi", hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ─── Bootstrap ──────────────────────────────────────────────────────────── */
if (token) {
  loadPortal().catch(() => logout());
} else {
  showScreen("loginView");
}
