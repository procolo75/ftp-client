import json
import os
import queue
import sys
import threading
import time
import webbrowser

# Auto-shutdown when the browser is closed (only when running as packaged exe)
_last_ping = [None]
_ping_lock = threading.Lock()


def _start_watchdog():
    def _watchdog():
        # Wait for the first ping before monitoring
        while True:
            time.sleep(2)
            with _ping_lock:
                if _last_ping[0] is not None:
                    break
        while True:
            time.sleep(5)
            with _ping_lock:
                last = _last_ping[0]
            if time.time() - last > 15:
                os._exit(0)

    threading.Thread(target=_watchdog, daemon=True).start()

from flask import Flask, Response, jsonify, render_template, request, session

import ftp_manager

_base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))

app = Flask(__name__,
            template_folder=os.path.join(_base, "templates"),
            static_folder=os.path.join(_base, "static"))
app.secret_key = os.urandom(32)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/connect", methods=["POST"])
def connect():
    data = request.get_json()
    host = (data.get("host") or "").strip()
    port = int(data.get("port") or 21)
    user = (data.get("user") or "").strip()
    password = data.get("password") or ""
    protocol = data.get("protocol") or "ftp"
    download_dir = (data.get("download_dir") or "").strip() or os.path.expanduser("~/Downloads")

    if not host or not user:
        return jsonify({"error": "Host e utente sono obbligatori"}), 400

    ftp_manager.set_session(host, port, user, password, protocol)

    try:
        ftp_manager.test_connection()
    except Exception as e:
        ftp_manager.clear_session()
        return jsonify({"error": str(e)}), 400

    session["download_dir"] = download_dir
    return jsonify({"ok": True})


@app.route("/api/disconnect", methods=["POST"])
def disconnect():
    ftp_manager.clear_session()
    session.clear()
    return jsonify({"ok": True})


@app.route("/api/status")
def status():
    s = ftp_manager.get_session()
    return jsonify({
        "connected": bool(s),
        "host": s.get("host", ""),
    })


@app.route("/api/ls")
def ls():
    if not ftp_manager.get_session():
        return jsonify({"error": "Non connesso"}), 401
    path = request.args.get("path", "/")
    try:
        entries = ftp_manager.list_directory(path)
        return jsonify({"entries": entries, "path": path})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/local/ls")
def local_ls():
    raw = request.args.get("path", "~")
    path = os.path.realpath(os.path.expanduser(raw))
    try:
        items = []
        for name in sorted(os.listdir(path), key=lambda n: (not os.path.isdir(os.path.join(path, n)), n.lower())):
            full = os.path.join(path, name)
            try:
                st = os.stat(full)
                items.append({
                    "name": name,
                    "type": "dir" if os.path.isdir(full) else "file",
                    "size": st.st_size,
                    "mtime": int(st.st_mtime),
                })
            except PermissionError:
                pass
        return jsonify({"entries": items, "path": path})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/download", methods=["POST"])
def download():
    if not ftp_manager.get_session():
        return jsonify({"error": "Non connesso"}), 401
    data = request.get_json()
    remote_path = data.get("remote_path")
    total_bytes = int(data.get("total_bytes") or 0)
    local_dir = data.get("local_dir") or os.path.expanduser("~/Downloads")

    if not remote_path:
        return jsonify({"error": "remote_path obbligatorio"}), 400

    os.makedirs(local_dir, exist_ok=True)

    if data.get("type") == "dir":
        try:
            count = ftp_manager.enqueue_download_dir(remote_path, local_dir)
        except Exception as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"files": count})

    job_id = ftp_manager.enqueue_download(remote_path, local_dir, total_bytes)
    return jsonify({"job_id": job_id})


@app.route("/api/upload", methods=["POST"])
def upload():
    """Upload a local file or folder (by path on this machine) to FTP."""
    if not ftp_manager.get_session():
        return jsonify({"error": "Non connesso"}), 401
    data = request.get_json()
    local_path = data.get("local_path")
    remote_dir = data.get("remote_dir", "/")

    if local_path and os.path.isdir(local_path):
        try:
            count = ftp_manager.enqueue_upload_dir(local_path, remote_dir)
        except Exception as e:
            return jsonify({"error": str(e)}), 500
        return jsonify({"files": count})

    if not local_path or not os.path.isfile(local_path):
        return jsonify({"error": "File locale non trovato"}), 400

    job_id = ftp_manager.enqueue_upload(local_path, remote_dir)
    return jsonify({"job_id": job_id})


@app.route("/api/queue")
def get_queue():
    return jsonify({"jobs": ftp_manager.get_queue()})


@app.route("/api/queue/clear", methods=["POST"])
def clear_queue():
    return jsonify({"removed": ftp_manager.clear_finished()})


@app.route("/api/queue/<job_id>", methods=["DELETE"])
def cancel_job(job_id):
    ok = ftp_manager.cancel_job(job_id)
    return jsonify({"ok": ok})


@app.route("/api/mkdir", methods=["POST"])
def mkdir():
    if not ftp_manager.get_session():
        return jsonify({"error": "Non connesso"}), 401
    data = request.get_json()
    path = data.get("path")
    if not path:
        return jsonify({"error": "path obbligatorio"}), 400
    try:
        ftp_manager.make_directory(path)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/delete", methods=["POST"])
def delete():
    if not ftp_manager.get_session():
        return jsonify({"error": "Non connesso"}), 401
    data = request.get_json()
    path = data.get("path")
    entry_type = data.get("type", "file")
    if not path:
        return jsonify({"error": "path obbligatorio"}), 400
    try:
        ftp_manager.delete_entry(path, entry_type)
        return jsonify({"ok": True})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/ping", methods=["POST"])
def ping():
    with _ping_lock:
        _last_ping[0] = time.time()
    return jsonify({"ok": True})


@app.route("/events")
def events():
    local_q = queue.Queue()
    ftp_manager.subscribe(local_q)

    def generate():
        try:
            while True:
                try:
                    event_type, data = local_q.get(timeout=30)
                    yield f"event: {event_type}\ndata: {json.dumps(data)}\n\n"
                except queue.Empty:
                    yield ": heartbeat\n\n"
        finally:
            ftp_manager.unsubscribe(local_q)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


if __name__ == "__main__":
    if getattr(sys, "frozen", False):
        _start_watchdog()

    def _open_browser():
        time.sleep(1.2)
        webbrowser.open("http://127.0.0.1:8080")

    threading.Thread(target=_open_browser, daemon=True).start()
    app.run(host="127.0.0.1", port=8080, debug=False, threaded=True)
