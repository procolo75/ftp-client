/* ── State ── */
let localPath  = "";
let remotePath = "/";
let connected  = false;
let selectedRemote = null;   // {name, type, path, size}
let dragState  = null;       // {source:'local'|'remote', path, name, type, size}
let jobCards   = {};

const STORAGE_KEY = "ftp-client-creds";

/* ── Init ── */
document.addEventListener("DOMContentLoaded", () => {
  loadSavedCreds();
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
    tr.draggable = !isDir; // drag only files for now
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

    // Drag from this row
    if (!isDir) {
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
    }

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

  const { source, path, name, size } = dragState;
  dragState = null;

  if (targetPanel === "remote" && source === "local") {
    // Upload: local file → FTP current dir
    if (!connected) { toast("Non connesso", "error"); return; }
    api("/api/upload", "POST", { local_path: path, remote_dir: remotePath })
      .then(res => {
        if (res.error) toast("Errore upload: " + res.error, "error");
        else toast(`Upload di "${name}" avviato`);
      });
  } else if (targetPanel === "local" && source === "remote") {
    // Download: FTP file → local current dir
    api("/api/download", "POST", {
      remote_path: path,
      local_dir: localPath,
      total_bytes: size,
    }).then(res => {
      if (res.error) toast("Errore download: " + res.error, "error");
      else toast(`Download di "${name}" avviato`);
    });
  }
}

/* ── Transfer queue ── */
function renderQueue(jobs) {
  const list = el("queue-list");
  const empty = el("queue-empty");

  jobs.forEach(job => {
    if (jobCards[job.id]) {
      updateJobCard(job);
    } else {
      const card = createJobCard(job);
      jobCards[job.id] = card;
      list.insertBefore(card, empty);
    }
  });

  empty.style.display = Object.keys(jobCards).length ? "none" : "";
}

function createJobCard(job) {
  const card = document.createElement("div");
  card.className = "job-card";
  card.id = "job-" + job.id;
  card.innerHTML = jobHTML(job);
  return card;
}

function updateJobCard(job) {
  const card = el("job-" + job.id);
  if (!card) return;
  card.className = "job-card " + job.status;
  card.innerHTML = jobHTML(job);
}

function jobHTML(job) {
  const icon = job.type === "download" ? "⬇" : "⬆";
  const pct  = job.percent || 0;
  const statusMap = { queued:"In coda", running:"In corso", done:"✓", error:"Errore", cancelled:"Annullato" };
  const isRunning = job.status === "running";
  const meta = isRunning && job.speed
    ? `${job.speed}${job.eta ? " · " + job.eta : ""}`
    : (statusMap[job.status] || job.status);
  const sizeStr = isRunning && job.total_bytes
    ? `${fmtSize(job.bytes_done || 0)} / ${fmtSize(job.total_bytes)}`
    : "";
  const cancel = (job.status === "queued" || job.status === "running")
    ? `<button class="job-cancel" onclick="cancelJob('${job.id}')" title="Annulla">✕</button>` : "";
  return `
    <span class="job-icon">${icon}</span>
    <div class="job-body">
      <div class="job-name" title="${esc(job.name)}">${esc(job.name)}</div>
      <div class="job-meta">${esc(meta)}</div>
      <div class="job-bar-wrap"><div class="job-bar" style="width:${pct}%"></div></div>
      ${sizeStr ? `<div class="job-size">${esc(sizeStr)}</div>` : ""}
    </div>
    ${cancel}
  `;
}

function cancelJob(jobId) {
  fetch(`/api/queue/${jobId}`, { method: "DELETE" });
}

function clearDone() {
  const list = el("queue-list");
  Object.entries(jobCards).forEach(([id, card]) => {
    if (["done","error","cancelled"].includes(card.dataset.status || card.className.replace("job-card ","").trim())) {
      list.removeChild(card);
      delete jobCards[id];
    }
    // Also clear by class
    if (card.classList.contains("done") || card.classList.contains("error") || card.classList.contains("cancelled")) {
      if (list.contains(card)) list.removeChild(card);
      delete jobCards[id];
    }
  });
  el("queue-empty").style.display = Object.keys(jobCards).length ? "none" : "";
}

/* ── SSE ── */
function startSSE() {
  const es = new EventSource("/events");

  es.addEventListener("progress", e => {
    const d = JSON.parse(e.data);
    const card = el("job-" + d.job_id);
    if (!card) return;
    const bar  = card.querySelector(".job-bar");
    const meta = card.querySelector(".job-meta");
    const size = card.querySelector(".job-size");
    if (bar)  bar.style.width = d.percent + "%";
    if (meta) meta.textContent = d.speed + (d.eta ? " · " + d.eta : "");
    if (size && d.total_bytes) size.textContent = fmtSize(d.bytes_done) + " / " + fmtSize(d.total_bytes);
  });

  es.addEventListener("job_done", e => {
    const d = JSON.parse(e.data);
    if (d.status === "done") {
      toast(`Trasferimento completato`, "success");
      // Refresh local panel in case it was a download
      browseLocalTo(localPath);
    }
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
  setInterval(async () => {
    const res = await api("/api/queue");
    if (!res.error && Array.isArray(res.jobs)) renderQueue(res.jobs);
  }, 1500);
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
