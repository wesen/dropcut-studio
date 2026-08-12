//
// DROPCUT Control — hardware control page.
//
// This page CAN move the machine. The safety shape, in order of authority:
//
//   1. The machine's PHYSICAL emergency stop. Everything below is convenience.
//   2. The firmware's continuous-jog dead-man: motion continues only while
//      keepalives arrive. This page forwards one keepalive per POST while a
//      jog button is HELD; releasing, hiding the tab, or crashing stops the
//      POSTs and the firmware stops the axis. No timer on any server keeps
//      motion alive.
//   3. The server's fresh preflight on every motion route. This page also
//      disables controls with a reason, but the server never trusts it.
//
// FEED HOLD and ABORT are never disabled: a stop that can be refused is not
// a stop. Escape is feed hold.

const $ = (id) => document.getElementById(id);

const AXES = ["X", "Y", "Z", "A", "B"];

let timer = null;
let consecutiveFailures = 0;
let lastStatus = null;

// Token for mutating routes when the server is reachable beyond loopback.
// Delivered in the URL by `z1ctl serve --allow-remote`, then kept in
// sessionStorage so the query string can be cleaned.
const urlToken = new URLSearchParams(location.search).get("token");
if (urlToken) {
  sessionStorage.setItem("z1token", urlToken);
  history.replaceState(null, "", location.pathname);
}
const TOKEN = sessionStorage.getItem("z1token") || "";

// ------------------------------- formatting -------------------------------

function fmtCoord(v) {
  if (typeof v !== "number" || !isFinite(v)) return "—";
  return v.toFixed(3).padStart(10, " ");
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function fmtRate(r, unit) {
  if (!r) return "—";
  const cur = r.Current ?? r.current ?? 0;
  const tgt = r.Target ?? r.target ?? 0;
  const ovr = r.Override ?? r.override ?? 0;
  return `${cur.toFixed(0)} / ${tgt.toFixed(0)} ${unit}  ·  ${ovr.toFixed(0)}%`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ---------------------------------- API -----------------------------------

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

async function post(url, body) {
  const headers = { "Content-Type": "application/json" };
  if (TOKEN) headers["X-Z1-Token"] = TOKEN;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body || {}),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.error) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}

function flash(message, isError) {
  const el = $("motionNote");
  el.textContent = message;
  el.classList.toggle("error", !!isError);
}

// -------------------------------- gating ----------------------------------

// The page disables controls with a REASON. The server re-checks everything;
// this is feedback, not enforcement.
function motionGate() {
  if (!lastStatus) return { ok: false, reason: "no connection to the machine" };
  const s = lastStatus;
  if (s.state === "Alarm") return { ok: false, reason: "machine is in Alarm — read Checks, then UNLOCK below" };
  if (s.playing && s.playing.Active) return { ok: false, reason: "a job is running — jog is disabled; PAUSE and ABORT remain" };
  if (s.state === "Home") return { ok: false, reason: "homing in progress" };
  if (s.state === "Hold") return { ok: false, reason: "feed hold — RESUME continues the held motion" };
  return { ok: true, reason: "" };
}

function applyGating() {
  const gate = motionGate();
  const playing = lastStatus && lastStatus.playing && lastStatus.playing.Active;
  const paused = lastStatus && (lastStatus.state === "Hold" || lastStatus.state === "Pause");

  document.querySelectorAll("#jogpad button").forEach((b) => (b.disabled = !gate.ok));
  $("homeBtn").disabled = !gate.ok;
  $("spindleOn").disabled = !gate.ok;
  document.querySelectorAll(".acc, .zero").forEach((b) => (b.disabled = !lastStatus));
  $("playBtn").disabled = !gate.ok || !selectedFile;

  // Stops are NEVER disabled by machine state — only by having no connection
  // at all, in which case there is no channel to send them on.
  $("hold").disabled = false;
  $("spindleOff").disabled = false;
  $("jobAbort").disabled = !playing && !paused;
  $("jobPause").disabled = !playing;
  $("jobResume").disabled = !paused;

  $("unlockBtn").hidden = !(lastStatus && lastStatus.state === "Alarm");

  if (!jogHeld) {
    flash(gate.ok
      ? "jog ready — hold a button to move, release to stop. Escape = feed hold."
      : gate.reason, !gate.ok);
  }
}

// -------------------------------- rendering -------------------------------

function renderStatus(s) {
  lastStatus = s;
  const dro = $("dro");
  dro.classList.remove("stale");

  for (let i = 0; i < AXES.length; i++) {
    const row = dro.querySelector(`[data-axis="${AXES[i]}"]`);
    row.querySelector(".w").textContent = fmtCoord(s.work[i]);
    row.querySelector(".m").textContent = fmtCoord(s.machine[i]);
  }

  // An unhomed machine reports -1 on the linear axes. Saying so is better than
  // showing a coordinate that looks real but references nothing.
  $("homedNote").innerHTML = s.homed
    ? '<span class="ok">homed</span>'
    : '<span class="warn">not homed</span> — machine coordinates are not meaningful; jog is relative and still works';

  $("state").textContent = s.state || "—";
  $("feed").textContent = fmtRate(s.feed, "mm/min");
  $("spindle").textContent = fmtRate(s.spindle, "rpm");
  $("tool").textContent =
    s.tool < 0 ? "none" : `T${s.tool}  ·  offset ${s.tlo.toFixed(3)} mm`;

  if (s.playing && s.playing.Active) {
    const p = s.playing;
    $("job").innerHTML =
      `<span class="ok">running</span> — line ${p.Lines}, ${p.Percent}%, ${p.Seconds}s elapsed`;
  } else {
    $("job").textContent = "idle";
  }

  $("raw").textContent = s.raw || "—";

  const drops = s.drops
    ? ` · <span class="warn">${s.drops} dropped frames</span>`
    : "";
  $("conn").innerHTML = `<span class="ok">connected</span>${drops}`;
  $("tick").textContent = new Date().toLocaleTimeString();

  applyGating();
}

function renderDisconnected(message) {
  lastStatus = null;
  $("dro").classList.add("stale");
  $("conn").innerHTML = `<span class="err">disconnected</span> <span class="dim">${escapeHtml(message)}</span>`;
  applyGating();
}

let selectedFile = null;

function renderFiles(payload) {
  const box = $("files");
  const files = payload.files || [];
  const dir = payload.dir || $("dir").value;
  if (files.length === 0) {
    box.innerHTML = '<div class="empty">no entries</div>';
    return;
  }
  box.innerHTML = files
    .map((f) => {
      const name = escapeHtml(f.Name ?? f.name ?? "");
      const isDir = f.IsDir ?? f.is_dir;
      const size = f.Size ?? f.size ?? 0;
      const when = escapeHtml(f.RawTime ?? f.raw_time ?? "");
      const cls = isDir ? "" : "selectable";
      const sel = !isDir && selectedFile === `${dir}/${f.Name ?? f.name}` ? " selected" : "";
      return `<div class="row ${cls}${sel}" data-file="${isDir ? "" : name}">
        <span class="val name ${isDir ? "dir" : ""}">${isDir ? name + "/" : name}</span>
        <span class="val num">${isDir ? "" : fmtSize(size)}</span>
        <span class="when">${formatStamp(when)}</span>
      </div>`;
    })
    .join("");
  $("filesNote").textContent = payload.cached ? "cached" : "";

  box.querySelectorAll(".row.selectable").forEach((row) => {
    row.addEventListener("click", () => {
      selectedFile = `${dir}/${row.dataset.file}`.replace(/\/+/g, "/");
      $("selName").textContent = selectedFile;
      box.querySelectorAll(".row").forEach((r) => r.classList.remove("selected"));
      row.classList.add("selected");
      applyGating();
    });
  });
}

// Timestamps arrive as YYYYMMDDHHMMSS in the machine's local time, and are
// meaningful only if its clock has been set — a Z1 boots near the epoch.
function formatStamp(s) {
  if (!/^\d{14}$/.test(s)) return s;
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

function renderChecks(payload) {
  const box = $("checks");
  const checks = payload.checks || [];
  box.innerHTML = checks
    .map(
      (c) => `<div class="row">
        <span class="sev ${escapeHtml(c.status)}">${escapeHtml(c.status)}</span>
        <span class="key">${escapeHtml(c.name)}</span>
        <span class="val">${escapeHtml(c.detail)}</span>
      </div>`
    )
    .join("");
}

function renderMachine(info) {
  const rows = [
    ["address", info.address],
    ["model", `${info.model} (id ${info.model_id}, func ${info.func_setting})`],
    ["firmware", `${info.version} ${info.community_firmware ? "(community)" : "(stock)"}`],
    ["protocol", info.protocol],
    ["upload types", `${info.file_types}${info.accepts_compressed_uploads ? "" : " — no compression"}`],
    ["machine clock", info.clock_epoch < 1000000000
      ? `epoch ${info.clock_epoch} — not set, so file timestamps are meaningless`
      : `epoch ${info.clock_epoch}`],
  ];
  $("machine").innerHTML = rows
    .map(
      ([k, v]) =>
        `<div class="row"><span class="key">${escapeHtml(k)}</span><span class="val">${escapeHtml(String(v))}</span></div>`
    )
    .join("");
}

// -------------------------------- polling ---------------------------------

async function pollStatus() {
  try {
    renderStatus(await getJSON("/api/status"));
    if (consecutiveFailures > 0) {
      consecutiveFailures = 0;
      refreshSlow();
    }
  } catch (err) {
    consecutiveFailures++;
    renderDisconnected(err.message);
  }
}

async function refreshFiles() {
  try {
    const dir = encodeURIComponent($("dir").value || "/sd/gcodes");
    renderFiles(await getJSON(`/api/files?dir=${dir}`));
  } catch (err) {
    $("files").innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
}

async function refreshSlow() {
  try {
    renderMachine(await getJSON("/api/info"));
  } catch (err) {
    $("machine").innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
  try {
    renderChecks(await getJSON("/api/doctor"));
  } catch (err) {
    $("checks").innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
  }
  refreshFiles();
}

function setInterval_(ms) {
  if (timer) clearInterval(timer);
  timer = null;
  if (ms > 0) {
    pollStatus();
    timer = setInterval(pollStatus, ms);
  }
}

// ------------------------------ two-step arm -------------------------------

// Dangerous single actions arm on the first press and fire on a second press
// within 3 seconds, with the armed state visible on the button itself. This
// is deliberately not a dialog: dialogs train people to dismiss them.
function armable(btn, label, fn) {
  let armed = null;
  btn.addEventListener("click", async () => {
    if (armed) {
      clearTimeout(armed);
      armed = null;
      btn.classList.remove("armed");
      btn.textContent = label;
      try {
        await fn();
      } catch (err) {
        flash(err.message, true);
      }
      return;
    }
    btn.classList.add("armed");
    btn.textContent = "sure? " + label;
    armed = setTimeout(() => {
      armed = null;
      btn.classList.remove("armed");
      btn.textContent = label;
    }, 3000);
  });
}

// ----------------------------------- jog -----------------------------------

let jogStep = "1"; // "0.1" | "1" | "10" | "hold"
let jogHeld = false;
let keepTimer = null;

$("stepSeg").querySelectorAll("button").forEach((b) => {
  b.addEventListener("click", () => {
    $("stepSeg").querySelectorAll("button").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    jogStep = b.dataset.step;
  });
});

// Jog speed is a scale of the axis maximum (0-1) — the unit the firmware's
// $J actually implements — so the page speaks the same unit.
function jogSpeedScale() {
  const v = parseFloat($("jogSpeed").value);
  return isFinite(v) && v > 0 && v < 1 ? v : 0;
}

async function stepJog(axis, dir) {
  const dist = parseFloat(jogStep) * dir;
  flash(`jog ${axis}${dist > 0 ? "+" : ""}${dist} …`);
  try {
    const res = await post("/api/jog", {
      axis, distance: dist, speed_scale: jogSpeedScale(),
      allow_open_cover: $("allowOpenCover").checked,
    });
    flash(`sent ${res.sent.join(" · ")} — state ${res.state_after}`);
  } catch (err) {
    flash(err.message, true);
  }
}

// Press-and-hold continuous jog. The chain that keeps the axis moving is:
// finger on button → pointer events → keepalive POSTs → one ?+0x1A write
// each → firmware timer. Any link breaking stops the machine.
async function holdJogStart(btn, axis, dir) {
  if (jogHeld) return;
  jogHeld = true;
  btn.classList.add("jogging");
  flash(`holding ${axis}${dir > 0 ? "+" : "−"} — release to stop`);
  try {
    await post("/api/jog/start", {
      axis, positive: dir > 0, speed_scale: jogSpeedScale(),
      allow_open_cover: $("allowOpenCover").checked,
    });
  } catch (err) {
    jogHeld = false;
    btn.classList.remove("jogging");
    flash(err.message, true);
    return;
  }
  keepTimer = setInterval(async () => {
    try {
      await post("/api/jog/keep");
    } catch {
      // A failed keepalive means the jog is over (server gone, session gone).
      // The machine has already stopped itself; just clean up the UI.
      holdJogStop(btn, true);
    }
  }, 150);
}

async function holdJogStop(btn, silent) {
  if (!jogHeld) return;
  jogHeld = false;
  if (keepTimer) clearInterval(keepTimer);
  keepTimer = null;
  if (btn) btn.classList.remove("jogging");
  document.querySelectorAll("#jogpad .jogging").forEach((b) => b.classList.remove("jogging"));
  try {
    const res = await post("/api/jog/stop");
    if (!silent) flash(res.ack ? "jog stopped (acknowledged)" : `jog stopped — ${res.note || ""}`);
  } catch (err) {
    if (!silent) flash(`stop request failed: ${err.message} — keepalives have ceased, the machine stops itself`, true);
  }
}

document.querySelectorAll("#jogpad .jb").forEach((btn) => {
  const axis = btn.dataset.axis;
  const dir = Number(btn.dataset.dir);
  btn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (jogStep === "hold") holdJogStart(btn, axis, dir);
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
    btn.addEventListener(ev, () => { if (jogStep === "hold") holdJogStop(btn); });
  }
  btn.addEventListener("click", () => {
    if (jogStep !== "hold") stepJog(axis, dir);
  });
});

// Anything that takes the operator's attention away stops the jog.
window.addEventListener("blur", () => holdJogStop());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) holdJogStop();
});

// -------------------------------- controls ---------------------------------

$("hold").addEventListener("click", async () => {
  try {
    await post("/api/hold");
    flash("FEED HOLD sent");
  } catch (err) {
    flash(`feed hold failed: ${err.message}`, true);
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") $("hold").click();
});

armable($("homeBtn"), "⌂ HOME", async () => {
  flash("homing ALL axes — this takes tens of seconds; the state shows Home while it runs");
  const res = await post("/api/home", { confirm: true });
  flash(`homing started — state ${res.state_after}`);
});

armable($("unlockBtn"), "UNLOCK", async () => {
  const res = await post("/api/unlock", {
    confirm: true,
    allow_open_cover: $("allowOpenCover").checked,
  });
  flash(res.ok ? `alarm cleared (was: ${res.halt_was}) — state ${res.state_after}` : (res.error || "not cleared"), !res.ok);
});

armable($("spindleOn"), "START", async () => {
  const rpm = parseInt($("rpm").value, 10);
  const res = await post("/api/spindle", { on: true, rpm, confirm: true });
  flash(`spindle: ${res.sent.join(" ")}`);
});

$("spindleOff").addEventListener("click", async () => {
  try {
    const res = await post("/api/spindle", { on: false });
    flash(`spindle off: ${res.sent.join(" ")}`);
  } catch (err) {
    flash(err.message, true);
  }
});

const accState = {};
document.querySelectorAll(".acc").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const name = btn.dataset.acc;
    const next = !accState[name];
    try {
      await post("/api/accessory", { name, on: next, power: 0 });
      accState[name] = next;
      btn.classList.toggle("on", next);
      flash(`${name} ${next ? "on" : "off"}`);
    } catch (err) {
      flash(err.message, true);
    }
  });
});

document.querySelectorAll(".zero").forEach((btn) => {
  armable(btn, btn.textContent, async () => {
    const axis = btn.dataset.zero;
    const res = await post("/api/wcs/zero", { axes: [axis], system: 1, confirm: true });
    flash(`work zero set: ${res.sent.join(" ")} — every ${axis} work coordinate now measures from here`);
  });
});

armable($("playBtn"), "▶ PLAY", async () => {
  if (!selectedFile) return;
  const res = await post("/api/job/play", { path: selectedFile, confirm: true });
  flash(`playing ${selectedFile} — ${res.sent.join(" ")}`);
});

$("jobPause").addEventListener("click", async () => {
  try {
    await post("/api/job/suspend");
    flash("job suspended");
  } catch (err) {
    flash(err.message, true);
  }
});

$("jobAbort").addEventListener("click", async () => {
  try {
    await post("/api/job/abort");
    flash("job aborted");
  } catch (err) {
    flash(err.message, true);
  }
});

armable($("jobResume"), "RESUME", async () => {
  await post("/api/job/resume", { confirm: true });
  flash("job resumed");
});

// ---------------------------------- wiring --------------------------------

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tabpane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $(`tab-${tab.dataset.tab}`).classList.add("active");
  });
});

$("interval").addEventListener("change", (e) => setInterval_(Number(e.target.value)));
$("reload").addEventListener("click", refreshFiles);
$("dir").addEventListener("keydown", (e) => { if (e.key === "Enter") refreshFiles(); });

setInterval_(Number($("interval").value));
refreshSlow();
applyGating();
