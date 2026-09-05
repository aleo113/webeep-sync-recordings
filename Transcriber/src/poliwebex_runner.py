from __future__ import annotations

import logging
import os
import re
import signal
import shutil
import subprocess
import threading
import time
from pathlib import Path

LOGGER = logging.getLogger(__name__)
MEDIA_EXTENSIONS = {".mp4", ".mkv", ".webm", ".mp3", ".m4a", ".wav"}


class PoliWebexRunner:
    def __init__(self, repo_path: Path) -> None:
        self.repo_path = repo_path
        self.script_path = self._find_script(repo_path)
        self.node_bin = self._resolve_binary("node", env_key="NODE_BIN")
        self.aria2c_bin = self._resolve_binary("aria2c", env_key="ARIA2C_BIN")
        self.ffmpeg_bin = self._resolve_binary("ffmpeg", env_key="FFMPEG_BIN")

    def validate_environment(self) -> None:
        if not self.repo_path.exists():
            raise FileNotFoundError(f"PoliWebex path not found: {self.repo_path}")

        if self.node_bin is None:
            raise RuntimeError(
                "Missing required dependency 'node'. "
                "Install Node.js or set NODE_BIN to an absolute path."
            )

        if self.ffmpeg_bin is None:
            raise RuntimeError(
                "Missing required dependency 'ffmpeg'. "
                "Install ffmpeg or set FFMPEG_BIN to an absolute path."
            )

        if self.aria2c_bin is None:
            LOGGER.warning(
                "'aria2c' was not found. PoliWebex may fail on downloads. "
                "Set ARIA2C_BIN to the binary path if installed outside PATH."
            )
        elif str(self.aria2c_bin).startswith("FLATPAK_HOST:"):
            LOGGER.info("Using aria2c from Flatpak host via flatpak-spawn")
        
        if self.ffmpeg_bin and str(self.ffmpeg_bin).startswith("FLATPAK_HOST:"):
            LOGGER.info("Using ffmpeg from Flatpak host via flatpak-spawn")

    def download_single(
        self,
        url: str,
        output_dir: Path,
        retry_interval: int = 1,
        skip_keyring: bool = True,
        cancel_event: threading.Event | None = None,
    ) -> Path:
        output_dir.mkdir(parents=True, exist_ok=True)

        started_at = time.time()
        run_on_host = self._should_run_on_host()
        flatpak_spawn_bin = shutil.which("flatpak-spawn")
        if run_on_host and flatpak_spawn_bin is None:
            LOGGER.warning(
                "Host execution requested but 'flatpak-spawn' is not available in PATH. "
                "Falling back to normal execution."
            )
            run_on_host = False

        cmd = [str(self.node_bin), str(self.script_path), "-v", url, "-o", str(output_dir), "-i", str(retry_interval)]
        if run_on_host:
            cmd = [flatpak_spawn_bin, "--host"] + cmd
        if skip_keyring:
            cmd.append("-k")

        env = os.environ.copy()
        path_entries: list[str] = []
        
        # Create temporary wrapper scripts for Flatpak host binaries
        wrapper_dir = output_dir / ".bin_wrappers"
        wrapper_dir.mkdir(parents=True, exist_ok=True)
        
        if self.node_bin is not None:
            path_entries.append(str(self.node_bin.parent))
        
        if self.aria2c_bin is not None and not run_on_host:
            if str(self.aria2c_bin).startswith("FLATPAK_HOST:"):
                host_path = str(self.aria2c_bin).replace("FLATPAK_HOST:", "")
                wrapper_script = wrapper_dir / "aria2c"
                wrapper_script.write_text(f"#!/bin/sh\nexec flatpak-spawn --host {host_path} \"$@\"\n")
                wrapper_script.chmod(0o755)
                path_entries.insert(0, str(wrapper_dir))
            else:
                path_entries.append(str(self.aria2c_bin.parent))
        
        if self.ffmpeg_bin is not None and not run_on_host:
            if str(self.ffmpeg_bin).startswith("FLATPAK_HOST:"):
                host_path = str(self.ffmpeg_bin).replace("FLATPAK_HOST:", "")
                wrapper_script = wrapper_dir / "ffmpeg"
                wrapper_script.write_text(f"#!/bin/sh\nexec flatpak-spawn --host {host_path} \"$@\"\n")
                wrapper_script.chmod(0o755)
                if str(wrapper_dir) not in path_entries:
                    path_entries.insert(0, str(wrapper_dir))
            else:
                path_entries.append(str(self.ffmpeg_bin.parent))

        existing_path = env.get("PATH", "")
        env["PATH"] = os.pathsep.join(path_entries + [existing_path]) if path_entries else existing_path

        if run_on_host:
            LOGGER.info("Running PoliWebex on host via flatpak-spawn for GUI login")
        LOGGER.info("Downloading lecture with PoliWebex: %s", url)
        proc = subprocess.Popen(
            cmd,
            cwd=str(self.repo_path),
            env=env,
            start_new_session=cancel_event is not None,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )

        output_tail: list[str] = []

        def drain_output() -> None:
            if proc.stdout is None:
                return
            for line in proc.stdout:
                cleaned = _strip_terminal_codes(line).strip()
                if not cleaned:
                    continue
                LOGGER.info("PoliWebex: %s", cleaned)
                output_tail.append(cleaned)
                del output_tail[:-40]

        output_thread = threading.Thread(
            target=drain_output,
            name="poliwebex-output",
            daemon=True,
        )
        output_thread.start()

        while proc.poll() is None:
            if cancel_event is not None and cancel_event.wait(0.5):
                try:
                    os.killpg(proc.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(proc.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    proc.wait()
                raise RuntimeError(f"Download cancelled for URL: {url}")
            if cancel_event is None:
                proc.wait()

        output_thread.join(timeout=2)
        if proc.stdout is not None:
            proc.stdout.close()
        if proc.returncode != 0:
            useful_output = [
                line
                for line in output_tail
                if "Project powered by" not in line and not line.startswith("Features:")
            ]
            details = useful_output[-1] if useful_output else "See application logs for details."
            raise RuntimeError(
                "PoliWebex failed for URL: "
                f"{url}\n{details}"
            )

        media_file = self._latest_media_after(output_dir, started_at)
        if media_file is None:
            media_file = self._latest_media(output_dir)
        if media_file is None:
            raise RuntimeError(
                "Download command completed but no media file was found in output directory."
            )

        return media_file

    def _find_script(self, repo_path: Path) -> Path:
        candidates = [
            repo_path / "poliwebex",
            repo_path / "poliwebex.js",
            repo_path / "src" / "poliwebex.js",
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate

        raise FileNotFoundError(
            f"Could not find PoliWebex executable script in {repo_path}. "
            "Expected one of: poliwebex, poliwebex.js, src/poliwebex.js"
        )

    def _latest_media_after(self, output_dir: Path, started_at: float) -> Path | None:
        candidates: list[Path] = []
        for path in output_dir.rglob("*"):
            if path.is_file() and path.suffix.lower() in MEDIA_EXTENSIONS and path.stat().st_mtime >= started_at:
                candidates.append(path)

        if not candidates:
            return None

        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates[0]

    def _latest_media(self, output_dir: Path) -> Path | None:
        candidates: list[Path] = []
        for path in output_dir.rglob("*"):
            if path.is_file() and path.suffix.lower() in MEDIA_EXTENSIONS:
                candidates.append(path)

        if not candidates:
            return None

        candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)
        return candidates[0]

    def _resolve_binary(self, name: str, env_key: str) -> Path | None:
        from_env = os.getenv(env_key)
        if from_env:
            candidate = Path(from_env).expanduser().resolve()
            if candidate.exists() and os.access(candidate, os.X_OK):
                return candidate

        resolved = shutil.which(name)
        if resolved:
            return Path(resolved).resolve()

        # Flatpak sandbox detection: try flatpak-spawn --host for system binaries
        if shutil.which("flatpak-spawn") and name in ("aria2c", "ffmpeg"):
            result = subprocess.run(
                ["flatpak-spawn", "--host", "which", name],
                capture_output=True,
                text=True,
                check=False,
            )
            if result.returncode == 0:
                host_path = result.stdout.strip()
                if host_path:
                    LOGGER.info("Found %s on Flatpak host at %s", name, host_path)
                    # Return a marker path that signals flatpak-spawn usage
                    return Path(f"FLATPAK_HOST:{host_path}")

        home = Path.home()
        if name == "node":
            nvm_nodes = sorted(home.glob(".nvm/versions/node/*/bin/node"), reverse=True)
            for node_path in nvm_nodes:
                if node_path.exists() and os.access(node_path, os.X_OK):
                    return node_path.resolve()

        if name == "aria2c":
            patterns = [
                "aria2-*/src/aria2c",
                "aria2-*/src/.libs/aria2c",
                "bin/aria2c",
                ".local/bin/aria2c",
            ]
            for pattern in patterns:
                for aria_path in home.glob(pattern):
                    if aria_path.exists() and os.access(aria_path, os.X_OK):
                        return aria_path.resolve()

        if name == "ffmpeg":
            for candidate in (Path("/usr/bin/ffmpeg"), Path("/usr/local/bin/ffmpeg")):
                if candidate.exists() and os.access(candidate, os.X_OK):
                    return candidate.resolve()

        return None

    def _should_run_on_host(self) -> bool:
        forced = os.getenv("POLIWEBEX_RUN_ON_HOST")
        if forced is not None:
            wants_host = forced.strip().lower() in {"1", "true", "yes", "on"}
            if wants_host and shutil.which("flatpak-spawn") is None:
                LOGGER.warning(
                    "POLIWEBEX_RUN_ON_HOST is enabled but 'flatpak-spawn' is not available. "
                    "Falling back to normal execution."
                )
                return False
            return wants_host

        if os.getenv("DISPLAY"):
            return False

        return shutil.which("flatpak-spawn") is not None


def _strip_terminal_codes(value: str) -> str:
    return re.sub(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])", "", value)
