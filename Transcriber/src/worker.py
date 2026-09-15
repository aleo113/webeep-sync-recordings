from __future__ import annotations

import json
import sys
import threading
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .api import ProcessOptions, TranscriberError, download_recording, process_media


def _send(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def _text_option(payload: dict[str, Any], key: str, default: str) -> str:
    """A present-but-blank payload value falls back to the default, so a
    cleared text field in the app cannot reach the CLI as --model ""."""
    value = str(payload.get(key) or "").strip()
    return value or default


def _options(payload: dict[str, Any]) -> ProcessOptions:
    return ProcessOptions(
        workspace_root=Path(payload["workspace_root"]),
        output_root=Path(payload["output_root"]),
        materials_root=Path(payload["materials_root"]) if payload.get("materials_root") else None,
        source_url=payload.get("source_url", ""),
        lecture_id=payload.get("lecture_id"),
        whisper_model=payload.get("whisper_model", "small"),
        whisper_language=payload.get("whisper_language"),
        whisper_num_cores=payload.get("whisper_num_cores"),
        notes_mode=payload.get("notes_mode", "transcript-only"),
        notes_provider=_text_option(payload, "notes_provider", "codex"),
        top_k_matches=int(payload.get("top_k_matches", 12)),
        codex_bin=payload.get("codex_bin", "codex"),
        codex_model=_text_option(payload, "codex_model", "gpt-5.6-luna"),
        codex_reasoning_effort=payload.get("codex_reasoning_effort", "high"),
        codex_timeout_seconds=int(payload.get("codex_timeout_seconds", 900)),
        antigravity_bin=_text_option(payload, "antigravity_bin", "agy"),
        antigravity_model=_text_option(payload, "antigravity_model", ""),
        claude_bin=payload.get("claude_bin", "claude"),
        claude_model=_text_option(payload, "claude_model", "sonnet"),
        max_slide_images=int(payload.get("max_slide_images", 8)),
        video_frames_enabled=bool(payload.get("video_frames_enabled", True)),
        video_frame_interval_seconds=int(payload.get("video_frame_interval_seconds", 60)),
        max_video_frames=int(payload.get("max_video_frames", 8)),
        max_total_images=int(payload.get("max_total_images", 12)),
        prefetch_downloads=bool(payload.get("prefetch_downloads", True)),
        whisper_profile=payload.get("whisper_profile", "balanced"),
        whisper_retry_model=payload.get("whisper_retry_model", "medium"),
        whisper_vad_filter=bool(payload.get("whisper_vad_filter", True)),
        whisper_max_retry_fraction=float(payload.get("whisper_max_retry_fraction", 0.25)),
    )


def main() -> int:
    cancelled: set[str] = set()
    lock = threading.Lock()

    for raw_line in sys.stdin:
        try:
            command = json.loads(raw_line)
            job_id = str(command["job_id"])
            if command.get("type") == "cancel":
                with lock:
                    cancelled.add(job_id)
                continue
            if command.get("type") not in {"start", "download"}:
                raise ValueError("Expected a start, download, or cancel command.")

            def progress(event) -> None:
                _send({"type": "progress", "job_id": job_id, **asdict(event)})

            try:
                if command["type"] == "download":
                    media_path = download_recording(
                        url=command["url"],
                        output_dir=Path(command["output_dir"]),
                        poliwebex_path=Path(command["poliwebex_path"]),
                        retry_interval=int(command.get("retry_interval", 1)),
                        skip_keyring=bool(command.get("skip_keyring", False)),
                        on_progress=progress,
                        spid_username=command.get("spid_username"),
                        spid_password=command.get("spid_password"),
                        polimi_email=command.get("polimi_email"),
                    )
                    _send(
                        {
                            "type": "complete",
                            "job_id": job_id,
                            "artifacts": {"media_file": str(media_path)},
                        }
                    )
                    continue
                artifacts = process_media(
                    Path(command["media_path"]),
                    _options(command),
                    on_progress=progress,
                    is_cancelled=lambda: job_id in cancelled,
                )
                _send(
                    {
                        "type": "complete",
                        "job_id": job_id,
                        "artifacts": {
                            key: str(value) if value is not None else None
                            for key, value in asdict(artifacts).items()
                        },
                    }
                )
            except TranscriberError as exc:
                _send({"type": "error", "job_id": job_id, "code": exc.code, "message": str(exc)})
            except Exception as exc:
                _send(
                    {
                        "type": "error",
                        "job_id": job_id,
                        "code": "PIPELINE_FAILED",
                        "message": str(exc),
                    }
                )
            finally:
                with lock:
                    cancelled.discard(job_id)
        except Exception as exc:
            _send({"type": "error", "job_id": "", "code": "INVALID_COMMAND", "message": str(exc)})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
