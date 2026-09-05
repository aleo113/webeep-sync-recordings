# WeBeep Sync Recordings

One repository for the WeBeep desktop app, recording downloads, transcription and lecture notes.

- `webeep-sync-recordings/`: Electron, React and TypeScript desktop app.
- `Transcriber/`: installable Python package and standalone CLI.
- `Transcriber/PoliWebex/`: included downloader source; no submodule checkout required.
- `scripts/workspace.py`: shared setup, launch and verification commands.

## Set up and run

Clone this repository and open its root directory. Use Python 3.10 or newer, Node.js 20 or newer, npm and pnpm 10.34.5. On Debian/Ubuntu, the native prerequisites are:

```sh
sudo apt install python3-venv ffmpeg aria2 build-essential pkg-config libsecret-1-dev
# Optional OCR for scanned course PDFs:
sudo apt install tesseract-ocr
npm install --global pnpm@10.34.5
python3 scripts/workspace.py setup
python3 scripts/workspace.py start
```

Setup creates `Transcriber/.venv`, installs the Python package in editable mode, and installs both JavaScript projects using their lockfiles. It can be rerun after pulling changes. It does not overwrite existing configuration or install system packages. Internet access is required for dependencies and the downloader browser; Whisper downloads the selected model on first use.

Sign in to WeBeep in the app and select the courses to sync. The desktop app finds the included Python environment and PoliWebex automatically. Check for recordings, download selected lectures, then transcribe them. Transcript-only and prompt-pack modes can run without the notes-generation login. Automated notes use the selected, locally authenticated Codex or Claude CLI; see the [Transcriber guide](Transcriber/README.md).

The setup helper also handles Windows virtual-environment paths (`python` can replace `python3`). On macOS and Windows, install the corresponding native tools and browser dependencies first. Linux is the locally verified development platform.

### macOS

Install Python, Node.js, ffmpeg and aria2 with your preferred package manager, plus pnpm 10.34.5. Then run the same setup command. On Apple Silicon, the older included Puppeteer version may need an installed Chrome browser:

```sh
export PUPPETEER_EXECUTABLE_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export PUPPETEER_SKIP_DOWNLOAD=true
python3 scripts/workspace.py setup
```

Keep that browser setting available when launching the app if using a custom browser. The worker adds Homebrew, nvm and local CLI directories to the PATH for macOS GUI launches. The standalone shell launcher works without GNU `readlink -f`. Actual macOS builds and SSO remain to be verified on a Mac.

## Verify changes

```sh
python3 scripts/workspace.py check
```

This runs the Python tests, checks the installed worker import, and runs the desktop linter, TypeScript checks and recording tests. The commands work from another directory when given the absolute path to `scripts/workspace.py`.

See the [repository review](docs/repository-review.md) for the fixes, verification results and remaining live-service/platform checks.

For the standalone CLI:

```sh
Transcriber/.venv/bin/python -m transcriber.cli --help
```

## Build the desktop app

```sh
cd webeep-sync-recordings
pnpm make
```

This builds the Electron package. A fully bundled Python runtime, native tools and Whisper models are a separate distribution step; the source setup above is the supported way to run the complete suite. Local macOS builds can remain unsigned. Signing requires `MACOS_IDENTITY`; notarization also requires `APPLEID`, `APPLEPWD` and `TEAMID`. The release workflows pass these values from repository secrets.

## Repository history and attribution

The migration preserves both project histories and the pinned PoliWebex history. All source directories are ordinary tracked files. Original licenses and attribution remain with their components; see [THIRD_PARTY.md](THIRD_PARTY.md). Local downloads, environments and credentials are ignored.
