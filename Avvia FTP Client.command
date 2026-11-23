#!/bin/zsh
# Doppio clic nel Finder per avviare l'FTP Client.
cd "$(dirname "$0")"
if lsof -iTCP:8080 -sTCP:LISTEN >/dev/null 2>&1; then
  open "http://127.0.0.1:8080"
  exit 0
fi
exec .venv/bin/python app.py
