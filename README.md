# FTP Client

A lightweight, browser-based FTP client that runs locally on your machine. No installation required — just download and run.

![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- Connect to FTP and FTPS servers
- Browse local and remote filesystems side by side
- Upload and download files via drag & drop
- Transfer queue with real-time progress (speed, ETA, bytes transferred)
- Resume interrupted transfers
- Create and delete files and folders
- Credentials saved locally in the browser

## Download

Go to the [Releases](../../releases) page and download the executable for your platform:

| Platform | File |
|----------|------|
| macOS | `ftp-client-macos.zip` — unzip and double-click `FTP Client.app` |
| Windows | `ftp-client-windows.exe` — double-click to run |
| Linux | `ftp-client-linux` — `chmod +x ftp-client-linux && ./ftp-client-linux` |

No Python, no dependencies, no installation needed.

> **macOS note:** on first launch, right-click the app → Open to bypass the Gatekeeper warning (unsigned app).

> **Windows note:** click "More info" → "Run anyway" on the SmartScreen prompt (unsigned executable).

## Usage

1. Launch the app — your browser opens automatically at `http://127.0.0.1:8080`
2. Enter your FTP server credentials and click **Connect**
3. Browse your files and drag them between the local and remote panels to transfer
4. Close the browser when done — the app shuts down automatically

## Build from source

Requirements: Python 3.10+

```bash
git clone https://github.com/your-username/ftp-client.git
cd ftp-client
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install flask pyinstaller
python3 app.py                   # Run in development mode
```

To build a standalone executable:

```bash
pyinstaller ftp_client.spec
# macOS: dist/FTP Client.app
# Windows/Linux: dist/ftp-client
```

## Release a new version

```bash
git tag v1.0.0
git push origin v1.0.0
```

GitHub Actions will automatically build executables for all three platforms and attach them to the release.

## License

MIT
