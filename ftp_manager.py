import ftplib
import os
import queue
import ssl
import threading
import time
import uuid

_session = {}

job_queue = queue.Queue()
jobs_state = {}
jobs_lock = threading.Lock()

_subscribers = []
_subscribers_lock = threading.Lock()


def subscribe(q):
    with _subscribers_lock:
        _subscribers.append(q)


def unsubscribe(q):
    with _subscribers_lock:
        if q in _subscribers:
            _subscribers.remove(q)


def _emit(event_type, data):
    with _subscribers_lock:
        for q in _subscribers:
            q.put((event_type, data))


def set_session(host, port, user, password, protocol="ftp"):
    global _session
    _session = {"host": host, "port": int(port), "user": user,
                 "password": password, "protocol": protocol}


def get_session():
    return dict(_session)


def clear_session():
    global _session
    _session = {}


def _connect():
    s = _session
    if s["protocol"] in ("ftps", "ftpes"):
        ctx = ssl.create_default_context()
        ctx.check_hostname = False
        ctx.verify_mode = ssl.CERT_NONE
        ftp = ftplib.FTP_TLS(context=ctx)
        ftp.connect(s["host"], s["port"], timeout=30)
        ftp.login(s["user"], s["password"])
        ftp.prot_p()
    else:
        ftp = ftplib.FTP()
        ftp.connect(s["host"], s["port"], timeout=30)
        ftp.login(s["user"], s["password"])
    return ftp


def _quit(ftp):
    try:
        ftp.quit()
    except Exception:
        pass


def test_connection():
    ftp = _connect()
    try:
        ftp.pwd()
    finally:
        _quit(ftp)


def list_directory(path):
    ftp = _connect()
    try:
        return _list_entries(ftp, path)
    finally:
        _quit(ftp)


def _list_entries(ftp, path):
    try:
        entries = []
        for name, facts in ftp.mlsd(path):
            ftype = facts.get("type", "").lower()
            # cdir/pdir are the current/parent dir: skipping them avoids loops when walking trees
            if name in (".", "..") or ftype in ("cdir", "pdir"):
                continue
            entry_type = "dir" if ftype == "dir" else "file"
            size = int(facts.get("size", 0) or 0)
            mtime = _fmt_mlsd_time(facts.get("modify", ""))
            entries.append({"name": name, "type": entry_type, "size": size, "mtime": mtime})
        return entries
    except ftplib.all_errors:
        lines = []
        ftp.dir(path, lines.append)
        return [e for e in _parse_listing("\n".join(lines)) if e["name"] not in (".", "..")]


def _fmt_mlsd_time(modify):
    if not modify or len(modify) < 8:
        return modify
    months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"]
    try:
        year = modify[0:4]
        month = int(modify[4:6])
        day = modify[6:8]
        hour = modify[8:10] if len(modify) >= 10 else ""
        minute = modify[10:12] if len(modify) >= 12 else ""
        mon_str = months[month - 1] if 1 <= month <= 12 else modify[4:6]
        if hour and minute:
            return f"{day} {mon_str} {year} {hour}:{minute}"
        return f"{day} {mon_str} {year}"
    except Exception:
        return modify


def make_directory(path):
    ftp = _connect()
    try:
        parts = [p for p in path.strip("/").split("/") if p]
        current = ""
        for part in parts:
            current += "/" + part
            try:
                ftp.mkd(current)
            except ftplib.error_perm:
                pass  # Already exists
    finally:
        _quit(ftp)


def delete_entry(path, entry_type):
    ftp = _connect()
    try:
        if entry_type == "dir":
            _delete_dir_recursive(ftp, path)
        else:
            ftp.delete(path)
    finally:
        _quit(ftp)


def _delete_dir_recursive(ftp, path):
    try:
        entries = list(ftp.mlsd(path))
    except ftplib.all_errors:
        lines = []
        ftp.dir(path, lines.append)
        parsed = _parse_listing("\n".join(lines))
        entries = [(e["name"], {"type": e["type"]}) for e in parsed]

    for name, facts in entries:
        if name in (".", ".."):
            continue
        full = path.rstrip("/") + "/" + name
        if facts.get("type", "file").lower() in ("dir", "cdir"):
            _delete_dir_recursive(ftp, full)
        else:
            ftp.delete(full)
    ftp.rmd(path)


def _download_job(remote_path, local_dir, total_bytes=0, label=None):
    name = os.path.basename(remote_path)
    return {
        "id": str(uuid.uuid4()),
        "type": "download",
        "name": label or name,
        "remote_path": remote_path,
        "local_path": os.path.join(local_dir, name),
        "total_bytes": total_bytes,
        "status": "queued",
        "percent": 0,
        "bytes_done": 0,
        "speed": "",
        "eta": "",
        "error": None,
        "cancel_event": threading.Event(),
    }


def _upload_job(local_path, remote_dir, label=None):
    name = os.path.basename(local_path)
    return {
        "id": str(uuid.uuid4()),
        "type": "upload",
        "name": label or name,
        "local_path": local_path,
        "remote_dir": remote_dir,
        "remote_path": remote_dir.rstrip("/") + "/" + name,
        "total_bytes": os.path.getsize(local_path),
        "status": "queued",
        "percent": 0,
        "bytes_done": 0,
        "speed": "",
        "eta": "",
        "error": None,
        "cancel_event": threading.Event(),
    }


def _submit(jobs):
    if not jobs:
        return
    with jobs_lock:
        for job in jobs:
            jobs_state[job["id"]] = job
    for job in jobs:
        job_queue.put(job)
    # One notification for the whole batch, not one per file
    _emit("queue_update", {"jobs": _snapshot()})


def enqueue_download(remote_path, local_dir, total_bytes=0):
    job = _download_job(remote_path, local_dir, total_bytes)
    _submit([job])
    return job["id"]


def enqueue_upload(local_path, remote_dir):
    job = _upload_job(local_path, remote_dir)
    _submit([job])
    return job["id"]


def enqueue_download_dir(remote_path, local_dir):
    """Recreate the remote tree under local_dir and enqueue a download per file.

    Returns the number of files enqueued.
    """
    remote_path = remote_path.rstrip("/")
    base = remote_path.rsplit("/", 1)[-1]
    jobs = []
    ftp = _connect()
    try:
        _collect_downloads(ftp, remote_path, os.path.join(local_dir, base), base, jobs)
    finally:
        _quit(ftp)
    _submit(jobs)
    return len(jobs)


def _collect_downloads(ftp, remote_dir, local_dir, label, jobs):
    os.makedirs(local_dir, exist_ok=True)
    for entry in sorted(_list_entries(ftp, remote_dir), key=lambda e: e["name"].lower()):
        rpath = remote_dir + "/" + entry["name"]
        elabel = label + "/" + entry["name"]
        if entry["type"] == "dir":
            _collect_downloads(ftp, rpath, os.path.join(local_dir, entry["name"]), elabel, jobs)
        else:
            jobs.append(_download_job(rpath, local_dir, entry["size"], elabel))


def enqueue_upload_dir(local_dir, remote_dir):
    """Recreate the local tree under remote_dir and enqueue an upload per file.

    Returns the number of files enqueued.
    """
    local_dir = os.path.normpath(local_dir)
    parent = os.path.dirname(local_dir)
    remote_root = remote_dir.rstrip("/") + "/" + os.path.basename(local_dir)
    jobs = []
    ftp = _connect()
    try:
        # os.walk is top-down, so parent dirs are created before their children
        for dirpath, dirnames, filenames in os.walk(local_dir):
            dirnames.sort()
            rel = os.path.relpath(dirpath, local_dir)
            target = remote_root if rel == "." else remote_root + "/" + rel.replace(os.sep, "/")
            try:
                ftp.mkd(target)
            except ftplib.error_perm:
                pass  # Already exists
            for name in sorted(filenames):
                path = os.path.join(dirpath, name)
                label = os.path.relpath(path, parent).replace(os.sep, "/")
                jobs.append(_upload_job(path, target, label))
    finally:
        _quit(ftp)
    _submit(jobs)
    return len(jobs)


def cancel_job(job_id):
    with jobs_lock:
        job = jobs_state.get(job_id)
        if not job:
            return False
        if job["status"] == "queued":
            job["status"] = "cancelled"
            _emit("queue_update", {"jobs": _snapshot()})
            return True
        if job["status"] == "running":
            job["cancel_event"].set()
            job["status"] = "cancelled"
            return True
    return False


def get_queue():
    with jobs_lock:
        return _snapshot()


def clear_finished():
    """Drop finished jobs from the queue. Returns how many were removed."""
    finished = ("done", "error", "cancelled")
    with jobs_lock:
        stale = [jid for jid, job in jobs_state.items() if job["status"] in finished]
        for jid in stale:
            del jobs_state[jid]
        snapshot = _snapshot()
    _emit("queue_update", {"jobs": snapshot})
    return len(stale)


def _snapshot():
    return [
        {k: v for k, v in job.items() if k != "cancel_event"}
        for job in jobs_state.values()
    ]


class _Cancelled(Exception):
    pass


def _make_progress_state(initial_offset, total):
    return {
        "transferred": initial_offset,
        "samples": [(initial_offset, time.time())],
        "total": total,
        "last_emit": 0,
    }


def _update_progress(state, delta, job):
    state["transferred"] += delta
    now = time.time()
    state["samples"].append((state["transferred"], now))
    if len(state["samples"]) > 6:
        state["samples"].pop(0)

    # Throttle SSE emissions to 2/second
    if now - state["last_emit"] < 0.5:
        return
    state["last_emit"] = now

    speed_bps = 0.0
    if len(state["samples"]) >= 2:
        db = state["samples"][-1][0] - state["samples"][0][0]
        dt = state["samples"][-1][1] - state["samples"][0][1]
        if dt > 0:
            speed_bps = db / dt

    total = state["total"]
    pct = int(state["transferred"] / total * 100) if total else 0
    speed_str = _fmt_speed(speed_bps)
    remaining = total - state["transferred"]
    eta_str = _fmt_eta(remaining / speed_bps) if speed_bps > 0 and total else ""

    with jobs_lock:
        job["percent"] = pct
        job["speed"] = speed_str
        job["eta"] = eta_str
        job["bytes_done"] = state["transferred"]

    _emit("progress", {
        "job_id": job["id"],
        "percent": pct,
        "speed": speed_str,
        "eta": eta_str,
        "bytes_done": state["transferred"],
        "total_bytes": total,
    })


def _do_download(ftp, job):
    remote_path = job["remote_path"]
    local_path = job["local_path"]
    cancel_event = job["cancel_event"]

    total = job["total_bytes"]
    if not total:
        try:
            total = ftp.size(remote_path) or 0
            with jobs_lock:
                job["total_bytes"] = total
        except Exception:
            pass

    offset = os.path.getsize(local_path) if os.path.exists(local_path) else 0
    state = _make_progress_state(offset, total)

    with open(local_path, "ab" if offset else "wb") as f:
        def callback(chunk):
            if cancel_event.is_set():
                raise _Cancelled()
            f.write(chunk)
            _update_progress(state, len(chunk), job)

        ftp.retrbinary(f"RETR {remote_path}", callback, rest=offset or None)


def _do_upload(ftp, job):
    local_path = job["local_path"]
    remote_path = job["remote_path"]
    total = job["total_bytes"]
    cancel_event = job["cancel_event"]

    offset = 0
    try:
        offset = ftp.size(remote_path) or 0
    except Exception:
        pass

    state = _make_progress_state(offset, total)

    def callback(chunk):
        if cancel_event.is_set():
            raise _Cancelled()
        _update_progress(state, len(chunk), job)

    with open(local_path, "rb") as f:
        if offset:
            f.seek(offset)
        ftp.storbinary(f"STOR {remote_path}", f, callback=callback, rest=offset or None)


def _fmt_speed(bps):
    if bps <= 0:
        return ""
    if bps >= 1024 * 1024:
        return f"{bps / (1024 * 1024):.1f} MiB/s"
    if bps >= 1024:
        return f"{bps / 1024:.1f} KiB/s"
    return f"{bps:.0f} B/s"


def _fmt_eta(seconds):
    if seconds <= 0 or seconds > 86400:
        return ""
    m, s = divmod(int(seconds), 60)
    if m >= 60:
        h, m = divmod(m, 60)
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


_MONTHS = {
    "jan":1,"feb":2,"mar":3,"apr":4,"may":5,"jun":6,
    "jul":7,"aug":8,"sep":9,"oct":10,"nov":11,"dec":12,
    "gen":1,"mag":5,"giu":6,"lug":7,"ago":8,"set":9,"ott":10,
}


def _parse_listing(output):
    entries = []
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        entry = _parse_line(line)
        if entry:
            entries.append(entry)
    return entries


def _parse_line(line):
    if not line or line[0] not in "dlbcps-":
        return None
    parts = line.split()
    if len(parts) < 4:
        return None

    type_char = line[0]

    date_idx = None
    for i, p in enumerate(parts):
        if p.lower() in _MONTHS and i + 2 < len(parts):
            date_idx = i
            break
    if date_idx is None:
        return None

    name_start = date_idx + 3
    if name_start > len(parts):
        return None
    name = " ".join(parts[name_start:]) if name_start < len(parts) else ""
    name = name.rstrip("/").split("/")[-1]
    if not name:
        return None

    date_str = " ".join(parts[date_idx:date_idx + 3])

    size = 0
    for p in reversed(parts[1:date_idx]):
        if p.isdigit():
            size = int(p)
            break

    return {
        "name": name,
        "type": "dir" if type_char == "d" else "file",
        "size": size,
        "mtime": date_str,
    }


def _worker():
    while True:
        job = job_queue.get()

        with jobs_lock:
            if job["status"] == "cancelled":
                continue
            job["status"] = "running"

        _emit("queue_update", {"jobs": _snapshot()})

        ftp = None
        try:
            ftp = _connect()
            if job["type"] == "download":
                _do_download(ftp, job)
            else:
                _do_upload(ftp, job)

            with jobs_lock:
                if job["status"] != "cancelled":
                    job["status"] = "done"

        except _Cancelled:
            pass

        except Exception as e:
            with jobs_lock:
                if job["status"] != "cancelled":
                    job["status"] = "error"
                    job["error"] = str(e)

        finally:
            if ftp:
                _quit(ftp)

        with jobs_lock:
            status = job["status"]
            error = job.get("error")

        _emit(
            "job_done" if status == "done" else "job_error",
            {"job_id": job["id"], "status": status, "error": error},
        )
        _emit("queue_update", {"jobs": _snapshot()})


threading.Thread(target=_worker, daemon=True).start()
