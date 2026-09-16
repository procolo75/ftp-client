/* ── State ── */
let localPath  = "";
let remotePath = "/";
let connected  = false;
let selectedRemote = null;   // {name, type, path, size}
let dragState  = null;       // {source:'local'|'remote', path, name, type, size}
let lastJobs   = [];         // latest queue snapshot from the server

const STORAGE_KEY = "ftp-client-creds";

/* ── Init ── */
document.addEventListener("DOMContentLoaded", () => {
  loadSavedCreds();
  initQueuePanel();
  startSSE();
  checkStatus();
  browseLocalTo("~");
  setInterval(() => fetch("/api/ping", { method: "POST" }).catch(() => {}), 5000);
});

/* ── Connection ── */
async function doConnect() {
  const host  = v("inp-host").trim();
  const port  = v("inp-port") || "21";
  const user  = v("inp-user").trim();
  const pass  = v("inp-pass");
  const proto = v("inp-proto");
  if (!host || !user) { toast("Inserisci host e utente", "error"); return; }

  showLoading("Connessione in corso...");
  const res = await api("/api/connect", "POST", {
    host, port: parseInt(port), user, password: pass, protocol: proto,
  });
  hideLoading();

  if (res.error) { toast("Errore: " + res.error, "error"); return; }

  saveCreds(host, port, user, pass, proto);
  setConnected(true, host);
  browseTo("/");
}

async function doDisconnect() {
  await api("/api/disconnect", "POST");
  setConnected(false);
  clearRemote();
}

async function checkStatus() {
  const res = await api("/api/status");
  if (res.connected) { setConnected(true, res.host); browseTo("/"); }
}

function setConnected(state, host) {
  connected = state;
  el("status-dot").className  = state ? "connected" : "";
  el("status-text").textContent = state ? "Connesso a " + host : "Disconnesso";
  el("btn-connect").classList.toggle("hidden", state);
  el("btn-disconnect").classList.toggle("hidden", !state);
  if (state) el("conn-panel").classList.add("hidden");
  ["remote-up","remote-mkdir","remote-delete"].forEach(id => el(id).disabled = !state);
}

function toggleConnPanel() { el("conn-panel").classList.toggle("hidden"); }

function saveCreds(host, port, user, pass, proto) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ host, port, user, pass, proto }));
}
function loadSavedCreds() {
  try {
    const c = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    if (c.host)  el("inp-host").value  = c.host;
    if (c.port)  el("inp-port").value  = c.port;
    if (c.user)  el("inp-user").value  = c.user;
    if (c.pass)  el("inp-pass").value  = c.pass;
    if (c.proto) el("inp-proto").value = c.proto;
  } catch(_) {}
}

/* ── Local browser ── */
async function browseLocalTo(path) {
  const res = await api("/api/local/ls?path=" + encodeURIComponent(path));
  if (res.error) { toast("Locale: " + res.error, "error"); return; }
  localPath = res.path;
  renderBreadcrumb("local-breadcrumb", localPath, browseLocalTo, true);
  renderFileList("local", res.entries, localPath, false);
  el("local-up").disabled = (localPath === "/" || !localPath);
}

function localUp() {
  const parent = localPath.replace(/\/[^/]+$/, "") || "/";
  browseLocalTo(parent || "/");
}

async function localMkdir() {
  const name = prompt("Nome della nuova cartella:");
  if (!name?.trim()) return;
  try {
    const { execSync } = { execSync: null };
    const res = await api("/api/local/mkdir", "POST", { path: localPath + "/" + name.trim() });
    if (res.error) toast(res.error, "error");
    else browseLocalTo(localPath);
  } catch(_) {
    // fallback: tell user
    toast("Crea la cartella manualmente nel Finder", "error");
  }
}

/* ── Remote browser ── */
async function browseTo(path) {
  if (!connected) return;
  selectedRemote = null;
  el("remote-delete").disabled = true;
  showLoading("Caricamento...");
  const res = await api("/api/ls?path=" + encodeURIComponent(path));
  hideLoading();
  if (res.error) { toast("FTP: " + res.error, "error"); return; }
  remotePath = res.path;
  renderBreadcrumb("remote-breadcrumb", remotePath, browseTo, false);
  renderFileList("remote", res.entries, remotePath, true);
  el("remote-up").disabled = (remotePath === "/" || !connected);
}

function remoteUp() {
  const parent = remotePath.replace(/\/[^/]+$/, "") || "/";
  browseTo(parent || "/");
}

function clearRemote() {
  el("remote-tbody").innerHTML = "";
  el("remote-table").style.display = "none";
  el("remote-empty").textContent = "Connettiti a un server FTP.";
  el("remote-empty").style.display = "";
  el("remote-breadcrumb").innerHTML = "";
  selectedRemote = null;
  remotePath = "/";
}

async function remoteMkdir() {
  const name = prompt("Nome della nuova cartella:");
  if (!name?.trim()) return;
  const fullPath = joinPath(remotePath, name.trim());
  const res = await api("/api/mkdir", "POST", { path: fullPath });
  if (res.error) toast("Errore: " + res.error, "error");
  else { toast("Cartella creata"); browseTo(remotePath); }
}

async function remoteDelete() {
  if (!selectedRemote) return;
  const msg = selectedRemote.type === "dir"
    ? `Eliminare la cartella "${selectedRemote.name}" e tutto il suo contenuto?`
    : `Eliminare il file "${selectedRemote.name}"?`;
  if (!confirm(msg)) return;
  const res = await api("/api/delete", "POST", { path: selectedRemote.path, type: selectedRemote.type });
  if (res.error) toast("Errore: " + res.error, "error");
  else { selectedRemote = null; browseTo(remotePath); }
}

/* ── Render helpers ── */
function renderBreadcrumb(containerId, path, onClickFn, isLocal) {
  const bc = el(containerId);
  bc.innerHTML = "";
  const parts = path === "/" ? [] : path.split("/").filter(Boolean);
  const roots = isLocal ? [] : [];

  const addCrumb = (label, targetPath) => {
    const s = document.createElement("span");
    s.className = "crumb";
    s.textContent = label;
    s.onclick = () => onClickFn(targetPath);
    bc.appendChild(s);
  };
  const addSep = () => {
    const s = document.createElement("span");
    s.className = "crumb-sep";
    s.textContent = " / ";
    bc.appendChild(s);
  };

  if (isLocal) {
    // Show full local path as breadcrumbs
    const segments = path.split("/").filter(Boolean);
    addCrumb("/", "/");
    let acc = "";
    segments.forEach(seg => {
      addSep();
      acc += "/" + seg;
      addCrumb(seg, acc);
    });
  } else {
    addCrumb("/", "/");
    let acc = "";
    parts.forEach(part => {
      addSep();
      acc += "/" + part;
      addCrumb(part, acc);
    });
  }
}

function renderFileList(panel, entries, basePath, isRemote) {
  const tbody = el(panel + "-tbody");
  const table = el(panel + "-table");
  const empty = el(panel + "-empty");

  tbody.innerHTML = "";

  if (!entries || entries.length === 0) {
    table.style.display = "none";
    empty.textContent = "Cartella vuota.";
    empty.style.display = "";
    return;
  }

  table.style.display = "";
  empty.style.display = "none";

  entries.forEach(entry => {
    const fullPath = joinPath(basePath, entry.name);
    const isDir = entry.type === "dir";
    const tr = document.createElement("tr");
    tr.draggable = true;
    tr.innerHTML = `
      <td class="col-icon">${isDir ? "📁" : fileIcon(entry.name)}</td>
      <td class="col-name" title="${esc(fullPath)}">${esc(entry.name)}</td>
      <td class="col-size">${isDir ? "—" : fmtSize(entry.size)}</td>
      <td class="col-act"></td>
    `;

    // Click: navigate dir or select file
    tr.addEventListener("click", () => {
      if (isDir) {
        if (isRemote) browseTo(fullPath);
        else browseLocalTo(fullPath);
      } else {
        selectRow(panel, tr, entry, fullPath, isRemote);
      }
    });

    // Drag from this row (files and folders)
    tr.addEventListener("dragstart", e => {
      dragState = {
        source: isRemote ? "remote" : "local",
        path: fullPath,
        name: entry.name,
        type: entry.type,
        size: entry.size || 0,
      };
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("text/plain", entry.name);
    });
    tr.addEventListener("dragend", () => { dragState = null; });

    tbody.appendChild(tr);
  });
}

function selectRow(panel, tr, entry, fullPath, isRemote) {
  document.querySelectorAll(`#${panel}-tbody tr.selected`).forEach(r => r.classList.remove("selected"));
  tr.classList.add("selected");
  if (isRemote) {
    selectedRemote = { name: entry.name, type: entry.type, path: fullPath, size: entry.size };
    el("remote-delete").disabled = false;
  }
}

/* ── Drag & Drop between panels ── */
function onPaneDragOver(e, targetPanel) {
  if (!dragState) return;
  // Only allow cross-panel drops
  if (dragState.source === targetPanel) return;
  if (targetPanel === "remote" && !connected) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
  el(targetPanel + "-panel").classList.add("drop-highlight");
}

function onPaneDragLeave(e) {
  // Only remove highlight when leaving the panel entirely
  const panel = e.currentTarget;
  if (!panel.contains(e.relatedTarget)) {
    panel.classList.remove("drop-highlight");
  }
}

function onPaneDrop(e, targetPanel) {
  e.preventDefault();
  el(targetPanel + "-panel").classList.remove("drop-highlight");
  if (!dragState || dragState.source === targetPanel) return;

  const { source, path, name, type, size } = dragState;
  dragState = null;
  const isDir = type === "dir";
  // Walking a folder tree can take a while: block the UI until the jobs are queued
  if (isDir) showLoading(`Preparazione di "${name}"...`);

  if (targetPanel === "remote" && source === "local") {
    // Upload: local file/folder → FTP current dir
    if (!connected) { hideLoading(); toast("Non connesso", "error"); return; }
    const destDir = remotePath;
    api("/api/upload", "POST", { local_path: path, remote_dir: destDir })
      .then(res => {
        if (isDir) hideLoading();
        if (res.error) { toast("Errore upload: " + res.error, "error"); return; }
        toast(`Upload di "${name}" avviato` + (isDir ? ` (${res.files} file)` : ""));
        // The folder now exists on the server: show it
        if (isDir && remotePath === destDir) browseTo(destDir);
      });
  } else if (targetPanel === "local" && source === "remote") {
    // Download: FTP file/folder → local current dir
    const destDir = localPath;
    api("/api/download", "POST", {
      remote_path: path,
      local_dir: destDir,
      total_bytes: size,
      type,
    }).then(res => {
      if (isDir) hideLoading();
      if (res.error) { toast("Errore download: " + res.error, "error"); return; }
      toast(`Download di "${name}" avviato` + (isDir ? ` (${res.files} file)` : ""));
      if (isDir && localPath === destDir) browseLocalTo(destDir);
    });
  }
}

/* ── Transfer queue ── */
const QUEUE_H_KEY     = "ftp-client-queue-h";
const QUEUE_COLL_KEY  = "ftp-client-queue-collapsed";
const QUEUE_DEFAULT_H = 200;
const QUEUE_MIN_H     = 92;
const MAX_ROWS        = 300;   // cap on rendered rows; the rest is summarised

const RANK = { running: 0, queued: 1, error: 2, cancelled: 3, done: 4 };
const STATE_LABEL = { queued: "In coda", running: "In corso", done: "Completato",
                      error: "Errore", cancelled: "Annullato" };

let queueFilter  = "all";
let jobRows      = {};   // job id -> {row, refs}
let rateSamples  = [];   // [totalBytesDone, timestamp] for the aggregate speed

function initQueuePanel() {
  const saved = parseInt(localStorage.getItem(QUEUE_H_KEY) || "", 10);
  if (saved) setQueueHeight(saved);
  if (localStorage.getItem(QUEUE_COLL_KEY) === "1") el("queue-strip").classList.add("collapsed");

  const handle = el("queue-resize");
  handle.addEventListener("mousedown", startQueueResize);
  handle.addEventListener("dblclick", () => setQueueHeight(QUEUE_DEFAULT_H, true));
  renderFilters();
}

function setQueueHeight(px, persist) {
  const max = Math.max(QUEUE_MIN_H, window.innerHeight - 160);
  const h = Math.min(Math.max(px, QUEUE_MIN_H), max);
  document.documentElement.style.setProperty("--queue-h", h + "px");
  if (persist !== false) localStorage.setItem(QUEUE_H_KEY, String(h));
}

function startQueueResize(e) {
  e.preventDefault();
  const strip = el("queue-strip");
  strip.classList.remove("collapsed");
  localStorage.setItem(QUEUE_COLL_KEY, "0");

  const startY = e.clientY;
  const startH = strip.getBoundingClientRect().height;
  document.body.classList.add("resizing-queue");

  const onMove = ev => setQueueHeight(startH + (startY - ev.clientY));
  const onUp = () => {
    document.body.classList.remove("resizing-queue");
    document.removeEventListener("mousemove", onMove);
    document.removeEventListener("mouseup", onUp);
  };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
}

function toggleQueue() {
  const collapsed = el("queue-strip").classList.toggle("collapsed");
  localStorage.setItem(QUEUE_COLL_KEY, collapsed ? "1" : "0");
}

function setQueueFilter(f) {
  queueFilter = f;
  renderQueue(lastJobs);
}

function renderFilters(counts) {
  const c = counts || { all: 0, running: 0, queued: 0, done: 0, error: 0 };
  const defs = [
    ["all",     "Tutti",      c.all,     ""],
    ["running", "In corso",   c.running, ""],
    ["queued",  "In coda",    c.queued,  ""],
    ["done",    "Completati", c.done,    ""],
    ["error",   "Errori",     c.error,   "err"],
  ];
  el("queue-filters").innerHTML = defs.map(([key, label, n, extra]) =>
    `<button class="qfilter ${extra} ${queueFilter === key ? "active" : ""}"
             onclick="setQueueFilter('${key}')">${label} ${n}</button>`
  ).join("");
}

function jobMatchesFilter(job) {
  if (queueFilter === "all") return true;
  if (queueFilter === "error") return job.status === "error" || job.status === "cancelled";
  return job.status === queueFilter;
}

function renderQueue(jobs) {
  lastJobs = jobs || [];
  const list = el("queue-list");

  const counts = { all: lastJobs.length, running: 0, queued: 0, done: 0, error: 0 };
  lastJobs.forEach(j => {
    if (j.status === "running") counts.running++;
    else if (j.status === "queued") counts.queued++;
    else if (j.status === "done") counts.done++;
    else counts.error++;               // error + cancelled
  });
  renderFilters(counts);
  updateAggregate();

  // Running first, then queued, then failures, then completed: what matters stays on top
  const visible = lastJobs
    .filter(jobMatchesFilter)
    .map((job, i) => ({ job, i }))
    .sort((a, b) => (RANK[a.job.status] ?? 9) - (RANK[b.job.status] ?? 9) || a.i - b.i)
    .map(x => x.job);

  const shown = visible.slice(0, MAX_ROWS);
  const shownIds = new Set(shown.map(j => j.id));

  Object.keys(jobRows).forEach(id => {
    if (!shownIds.has(id)) {
      jobRows[id].row.remove();
      delete jobRows[id];
    }
  });

  let prev = null;
  shown.forEach(job => {
    let entry = jobRows[job.id];
    if (!entry) {
      entry = buildJobRow(job);
      jobRows[job.id] = entry;
    }
    updateJobRow(job);
    // Move into place only when it is not already there (keeps DOM churn low)
    const target = prev ? prev.nextSibling : list.firstChild;
    if (entry.row !== target) list.insertBefore(entry.row, target);
    prev = entry.row;
  });

  el("queue-empty").style.display = shown.length ? "none" : "";
  if (el("queue-empty").parentNode === list) list.appendChild(el("queue-empty"));

  const more = el("queue-more");
  const hidden = visible.length - shown.length;
  more.classList.toggle("hidden", hidden <= 0);
  if (hidden > 0) more.textContent = `… e altri ${hidden} file in elenco`;
}

function buildJobRow(job) {
  const row = document.createElement("div");
  row.id = "job-" + job.id;
  row.className = "job-row";
  row.innerHTML = `
    <span class="job-icon"></span>
    <span class="job-name"><span class="job-dir"></span><span class="job-base"></span></span>
    <span class="job-bar-wrap"><span class="job-bar"></span></span>
    <span class="job-bytes"></span>
    <span class="job-rate"></span>
    <span class="job-eta"></span>
    <button class="job-cancel" title="Annulla">✕</button>
  `;
  const refs = {
    icon:  row.querySelector(".job-icon"),
    dir:   row.querySelector(".job-dir"),
    base:  row.querySelector(".job-base"),
    bar:   row.querySelector(".job-bar"),
    bytes: row.querySelector(".job-bytes"),
    rate:  row.querySelector(".job-rate"),
    eta:   row.querySelector(".job-eta"),
    cancel: row.querySelector(".job-cancel"),
  };
  refs.cancel.onclick = () => cancelJob(job.id);

  const name = String(job.name || "");
  const cut = name.lastIndexOf("/");
  refs.dir.textContent  = cut >= 0 ? name.slice(0, cut + 1) : "";
  refs.base.textContent = cut >= 0 ? name.slice(cut + 1) : name;
  row.title = (job.type === "download" ? "Download: " : "Upload: ") + name;
  refs.icon.textContent = job.type === "download" ? "⬇" : "⬆";
  return { row, refs };
}

function updateJobRow(job) {
  const entry = jobRows[job.id];
  if (!entry) return;
  const { row, refs } = entry;
  const running = job.status === "running";

  const cls = "job-row " + job.status;
  if (row.className !== cls) row.className = cls;

  const pct = job.status === "done" ? 100 : (job.percent || 0);
  const w = pct + "%";
  if (refs.bar.style.width !== w) refs.bar.style.width = w;

  const total = job.total_bytes || 0;
  setText(refs.bytes, running && total
    ? `${fmtSize(job.bytes_done || 0)} / ${fmtSize(total)}`
    : (total ? fmtSize(total) : "—"));

  setText(refs.rate, running ? (job.speed || "") : (STATE_LABEL[job.status] || job.status));
  refs.rate.className = running ? "job-rate" : "job-rate job-state";

  setText(refs.eta, running ? (job.eta || "") : (pct ? pct + "%" : ""));

  const cancellable = job.status === "queued" || job.status === "running";
  refs.cancel.classList.toggle("placeholder", !cancellable);
  refs.cancel.disabled = !cancellable;
}

function setText(node, txt) {
  if (node.textContent !== txt) node.textContent = txt;
}

/* Overall progress: counts, bytes, aggregate speed and ETA across the whole queue */
function updateAggregate() {
  const jobs = lastJobs;
  const active = jobs.filter(j => j.status !== "cancelled");
  const totalBytes = active.reduce((a, j) => a + (j.total_bytes || 0), 0);
  const doneBytes = active.reduce(
    (a, j) => a + (j.status === "done" ? (j.total_bytes || 0) : (j.bytes_done || 0)), 0);
  const doneCount = jobs.filter(j => j.status === "done").length;
  const errCount  = jobs.filter(j => j.status === "error").length;
  const pending   = jobs.filter(j => j.status === "running" || j.status === "queued").length;

  const pct = totalBytes ? Math.min(100, doneBytes / totalBytes * 100) : (jobs.length && !pending ? 100 : 0);
  el("queue-total-fill").style.width = pct.toFixed(1) + "%";

  // Aggregate speed from a rolling window of total bytes transferred
  const now = Date.now();
  rateSamples.push([doneBytes, now]);
  while (rateSamples.length > 2 && now - rateSamples[0][1] > 6000) rateSamples.shift();
  if (rateSamples.length > 12) rateSamples.shift();
  let bps = 0;
  if (pending && rateSamples.length >= 2) {
    const [b0, t0] = rateSamples[0], [b1, t1] = rateSamples[rateSamples.length - 1];
    const dt = (t1 - t0) / 1000;
    if (dt > 0.5) bps = Math.max(0, (b1 - b0) / dt);
  }

  const parts = [];
  if (!jobs.length) {
    parts.push('<span class="strong">Nessun trasferimento</span>');
  } else {
    parts.push(`<span class="strong">${doneCount}/${jobs.length} file</span>`);
    if (totalBytes) parts.push(`${fmtSize(doneBytes)} / ${fmtSize(totalBytes)} · ${Math.round(pct)}%`);
    if (bps > 0) parts.push(`<span class="rate">${fmtSize(bps)}/s</span>`);
    if (bps > 0 && totalBytes > doneBytes) parts.push(`~${fmtDuration((totalBytes - doneBytes) / bps)} rimanenti`);
    if (!pending && jobs.length) parts.push(errCount ? `${errCount} falliti` : "tutto completato");
  }
  el("queue-summary").innerHTML = parts.join('<span class="sep">·</span>');

  const label = pending ? `Trasferimenti (${pending})` : "Trasferimenti";
  setText(el("queue-label"), label);
  document.title = pending ? `${Math.round(pct)}% · FTP Client` : "FTP Client";
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + "s";
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return s ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function cancelJob(jobId) {
  fetch(`/api/queue/${jobId}`, { method: "DELETE" });
}

function clearDone() {
  const keep = lastJobs.filter(j => !["done", "error", "cancelled"].includes(j.status));
  const removed = lastJobs.length - keep.length;
  rateSamples = [];
  renderQueue(keep);
  fetch("/api/queue/clear", { method: "POST" })
    .then(() => refreshQueue())
    .catch(() => {});
  if (removed) toast(`${removed} voci rimosse dall'elenco`);
}

async function refreshQueue() {
  const res = await api("/api/queue");
  if (!res.error && Array.isArray(res.jobs)) renderQueue(res.jobs);
}

/* ── SSE ── */
function startSSE() {
  const es = new EventSource("/events");

  es.addEventListener("progress", e => {
    const d = JSON.parse(e.data);
    // Patch the local snapshot so the row and the aggregate stay in sync
    const job = lastJobs.find(j => j.id === d.job_id);
    if (job) {
      job.status      = "running";
      job.percent     = d.percent;
      job.speed       = d.speed;
      job.eta         = d.eta;
      job.bytes_done  = d.bytes_done;
      job.total_bytes = d.total_bytes || job.total_bytes;
      updateJobRow(job);
      updateAggregate();
    }
  });

  es.addEventListener("job_done", e => {
    const d = JSON.parse(e.data);
    if (d.status !== "done") return;
    // A folder transfer is many jobs: notify only once the queue has drained
    const pending = lastJobs.some(j => j.id !== d.job_id && (j.status === "queued" || j.status === "running"));
    if (pending) return;
    toast(`Trasferimento completato`, "success");
    // Refresh local panel in case it was a download
    browseLocalTo(localPath);
  });

  es.addEventListener("job_error", e => {
    const d = JSON.parse(e.data);
    toast("Trasferimento fallito: " + (d.error || "errore sconosciuto"), "error");
  });

  es.addEventListener("queue_update", e => {
    const d = JSON.parse(e.data);
    renderQueue(d.jobs || d);
  });

  // Polling fallback: aggiorna la coda ogni 1.5 s anche se SSE non recapita eventi
  setInterval(refreshQueue, 1500);
}

/* ── Utilities ── */
function el(id) { return document.getElementById(id); }
function v(id)  { return el(id).value; }
function esc(s) {
  return String(s ?? "")
    .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

async function api(path, method = "GET", body = null) {
  const opts = { method, headers: body ? { "Content-Type": "application/json" } : {} };
  if (body) opts.body = JSON.stringify(body);
  try {
    const r = await fetch(path, opts);
    return await r.json();
  } catch(e) { return { error: e.message }; }
}

function joinPath(base, name) {
  return (base.endsWith("/") ? base : base + "/") + name;
}

function fmtSize(bytes) {
  if (!bytes) return "0 B";
  const k = 1024, s = ["B","KiB","MiB","GiB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), s.length - 1);
  return (bytes / Math.pow(k, i)).toFixed(i ? 1 : 0) + " " + s[i];
}

function fileIcon(name) {
  const ext = (name.split(".").pop() || "").toLowerCase();
  const m = { pdf:"📄",zip:"📦",gz:"📦",tar:"📦","7z":"📦",
    jpg:"🖼",jpeg:"🖼",png:"🖼",gif:"🖼",svg:"🖼",
    mp4:"🎬",avi:"🎬",mov:"🎬",mkv:"🎬",
    mp3:"🎵",wav:"🎵",flac:"🎵",
    txt:"📝",md:"📝",csv:"📊",xls:"📊",xlsx:"📊",
    js:"💻",ts:"💻",py:"💻",sh:"💻",html:"💻",css:"💻" };
  return m[ext] || "📄";
}

function showLoading(t) { el("loading-text").textContent = t; el("loading").classList.remove("hidden"); }
function hideLoading()  { el("loading").classList.add("hidden"); }

function toast(msg, type = "") {
  const t = document.createElement("div");
  t.className = "toast" + (type ? " " + type : "");
  t.textContent = msg;
  el("toast-container").appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
