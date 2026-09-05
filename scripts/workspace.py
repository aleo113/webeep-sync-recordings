#!/usr/bin/env python3
"""Set up, start and check the combined checkout from any working directory."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
APP = ROOT / "webeep-sync-recordings"
TRANSCRIBER = ROOT / "Transcriber"
PYTHON = TRANSCRIBER / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def executable(name: str) -> str:
    resolved = shutil.which(name)
    if not resolved:
        raise RuntimeError(f"Missing {name} on PATH. See the prerequisites in README.md.")
    return resolved


def run(*args: str | Path, cwd: Path = ROOT) -> None:
    print(f"[{cwd.name}] {' '.join(map(str, args))}", flush=True)
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def setup() -> None:
    npm, pnpm = executable("npm"), executable("pnpm")
    executable("ffmpeg")
    executable("aria2c")
    node_version = subprocess.check_output([executable("node"), "--version"], text=True)
    if int(node_version.lstrip("v").split(".")[0]) < 20:
        raise RuntimeError("Node.js 20 or newer is required.")
    expected = json.loads((APP / "package.json").read_text())["packageManager"].split("@")[1]
    actual = subprocess.check_output([pnpm, "--version"], cwd=APP, text=True).strip()
    if actual != expected:
        raise RuntimeError(f"Expected pnpm {expected}, found {actual}. Install the version in README.md.")
    if not PYTHON.exists():
        run(sys.executable, "-m", "venv", TRANSCRIBER / ".venv")
    run(PYTHON, "-m", "pip", "install", "-e", TRANSCRIBER)
    run(npm, "ci", cwd=TRANSCRIBER / "PoliWebex")
    run(executable("node"), "-e",
        "require('keytar'); const fs = require('fs'); "
        "const browser = process.env.PUPPETEER_EXECUTABLE_PATH || require('puppeteer').executablePath(); "
        "if (!fs.existsSync(browser)) throw new Error('Downloader browser is missing. Check install scripts and PUPPETEER_EXECUTABLE_PATH.');",
        cwd=TRANSCRIBER / "PoliWebex")
    run(pnpm, "install", "--frozen-lockfile", cwd=APP)
    run(PYTHON, "-c", "import transcriber.worker")
    print("Setup complete. Start with: python3 scripts/workspace.py start")


def check() -> None:
    if not PYTHON.exists():
        raise RuntimeError("Run python3 scripts/workspace.py setup first.")
    run(PYTHON, "-m", "unittest", "discover", "-s", "tests", cwd=TRANSCRIBER)
    run(PYTHON, "-c", "import transcriber.worker", cwd=ROOT)
    pnpm = executable("pnpm")
    for script in ("lint", "type-check", "test"):
        run(pnpm, "run", script, cwd=APP)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "start", "check"))
    args = parser.parse_args()
    if sys.version_info < (3, 10):
        parser.error("Python 3.10 or newer is required.")
    try:
        if args.command == "setup":
            setup()
        elif args.command == "check":
            check()
        else:
            run(executable("pnpm"), "start", cwd=APP)
    except (RuntimeError, OSError, subprocess.CalledProcessError) as exc:
        print(f"Error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
