//
// DROPCUT Control — hardware control page.
//
// Read-only. Every request is a GET; nothing here can move the machine.
//
// The page polls one endpoint on a timer rather than opening a websocket. The
// machine accepts a single TCP connection which the Go server holds and
// serialises, so a push channel would not reduce the number of round trips to
// the machine — it would only move the polling from the browser to the server.

const $ = (id) => document.getElementById(id);

const AXES = ["X", "Y", "Z", "A", "B"];

let timer = null;
let consecutiveFailures = 0;

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

// -------------------------------- rendering -------------------------------

function renderStatus(s) {
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
    : '<span class="warn">not homed</span> — machine coordinates are not meaningful';

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
}

function renderDisconnected(message) {
  $("dro").classList.add("stale");
  $("conn").innerHTML = `<span class="err">disconnected</span> <span class="dim">${escapeHtml(message)}</span>`;
}

function renderFiles(payload) {
  const box = $("files");
  const files = payload.files || [];
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
      return `<div class="row">
        <span class="val name ${isDir ? "dir" : ""}">${isDir ? name + "/" : name}</span>
        <span class="val num">${isDir ? "" : fmtSize(size)}</span>
        <span class="when">${formatStamp(when)}</span>
      </div>`;
    })
    .join("");
  $("filesNote").textContent = payload.cached ? "cached" : "";
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// -------------------------------- polling ---------------------------------

async function getJSON(url) {
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.json();
  if (!res.ok || body.error) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

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
