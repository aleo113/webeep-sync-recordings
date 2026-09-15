from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


@dataclass
class AppConfig:
    poliwebex_path: Path
    whisper_model: str
    whisper_language: str | None
    whisper_num_cores: int | None
    top_k_matches: int
    notes_mode: str
    codex_bin: str
    codex_model: str
    codex_reasoning_effort: str
    codex_timeout_seconds: int
    max_slide_images: int
    notes_provider: str = "codex"
    claude_bin: str = "claude"
    claude_model: str = "sonnet"
    video_frames_enabled: bool = True
    video_frame_interval_seconds: int = 60
    max_video_frames: int = 8
    max_total_images: int = 12
    prefetch_downloads: bool = True
    whisper_profile: str = "balanced"
    whisper_retry_model: str = "medium"
    whisper_vad_filter: bool = True
    whisper_max_retry_fraction: float = 0.25
    antigravity_bin: str = "agy"
    antigravity_model: str = ""


def _read_env_file_value(key: str, env_file: Path = Path(".env")) -> str:
    if not env_file.is_file():
        return ""

    for raw_line in env_file.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        parsed_key, parsed_value = line.split("=", 1)
        if parsed_key.strip() != key:
            continue

        value = parsed_value.strip().strip('"').strip("'")
        return value

    return ""


def from_env(
    explicit_poliwebex_path: str | None,
    top_k_matches: int | None,
    explicit_whisper_language: str | None = None,
    explicit_whisper_num_cores: int | None = None,
    explicit_notes_mode: str | None = None,
    explicit_notes_provider: str | None = None,
    explicit_codex_model: str | None = None,
    explicit_claude_model: str | None = None,
    explicit_codex_reasoning_effort: str | None = None,
    explicit_video_frames_enabled: bool | None = None,
    explicit_video_frame_interval_seconds: int | None = None,
    explicit_max_video_frames: int | None = None,
    explicit_max_total_images: int | None = None,
    explicit_prefetch_downloads: bool | None = None,
    explicit_whisper_profile: str | None = None,
    explicit_whisper_retry_model: str | None = None,
    explicit_whisper_vad_filter: bool | None = None,
    explicit_whisper_max_retry_fraction: float | None = None,
    explicit_antigravity_model: str | None = None,
) -> AppConfig:
    env_path = explicit_poliwebex_path or os.getenv("POLIWEBEX_PATH", "") or _read_env_file_value("POLIWEBEX_PATH")
    if not env_path:
        bundled_path = Path(__file__).resolve().parent.parent / "PoliWebex"
        if not (bundled_path / "poliwebex.js").is_file():
            raise ValueError("PoliWebex path is required. Pass --poliwebex-path or set POLIWEBEX_PATH.")
        env_path = str(bundled_path)

    whisper_model = os.getenv("WHISPER_MODEL", "small")
    raw_whisper_language = (
        explicit_whisper_language
        if explicit_whisper_language is not None
        else os.getenv("WHISPER_LANGUAGE", "")
    )
    whisper_language = raw_whisper_language.strip() or None
    whisper_num_cores_env = os.getenv("WHISPER_NUM_CORES")
    whisper_num_cores = (
        explicit_whisper_num_cores
        if explicit_whisper_num_cores is not None
        else int(whisper_num_cores_env)
        if whisper_num_cores_env
        else None
    )
    top_k = top_k_matches if top_k_matches is not None else int(os.getenv("TOP_K_MATCHES", "12"))
    notes_mode = (explicit_notes_mode or os.getenv("NOTES_MODE", "api")).strip().lower()
    if notes_mode not in {"transcript-only", "prompt-pack", "api"}:
        raise ValueError("NOTES_MODE must be 'transcript-only', 'prompt-pack', or 'api'.")
    notes_provider = (
        explicit_notes_provider or os.getenv("NOTES_PROVIDER", "codex")
    ).strip().lower()
    if notes_provider not in {"codex", "claude", "antigravity"}:
        raise ValueError("NOTES_PROVIDER must be 'codex', 'claude', or 'antigravity'.")
    codex_bin = os.getenv("CODEX_BIN", "codex").strip() or "codex"
    codex_model = (explicit_codex_model or os.getenv("CODEX_MODEL", "gpt-5.6-luna")).strip()
    claude_bin = os.getenv("CLAUDE_BIN", "claude").strip() or "claude"
    claude_model = (explicit_claude_model or os.getenv("CLAUDE_MODEL", "sonnet")).strip()
    if not claude_model:
        raise ValueError("CLAUDE_MODEL cannot be empty.")
    codex_reasoning_effort = (
        explicit_codex_reasoning_effort or os.getenv("CODEX_REASONING_EFFORT", "high")
    ).strip().lower()
    if codex_reasoning_effort not in {"none", "minimal", "low", "medium", "high", "xhigh", "max"}:
        raise ValueError(
            "CODEX_REASONING_EFFORT must be one of: none, minimal, low, medium, high, xhigh, max."
        )
    codex_timeout_seconds = int(os.getenv("CODEX_TIMEOUT_SECONDS", "900"))
    max_slide_images = int(os.getenv("MAX_SLIDE_IMAGES", "8"))
    video_frames_enabled = (
        explicit_video_frames_enabled
        if explicit_video_frames_enabled is not None
        else _env_bool("VIDEO_FRAMES_ENABLED", True)
    )
    video_frame_interval_seconds = (
        explicit_video_frame_interval_seconds
        if explicit_video_frame_interval_seconds is not None
        else int(os.getenv("VIDEO_FRAME_INTERVAL_SECONDS", "60"))
    )
    max_video_frames = (
        explicit_max_video_frames
        if explicit_max_video_frames is not None
        else int(os.getenv("MAX_VIDEO_FRAMES", "8"))
    )
    max_total_images = (
        explicit_max_total_images
        if explicit_max_total_images is not None
        else int(os.getenv("MAX_TOTAL_IMAGES", "12"))
    )
    prefetch_downloads = (
        explicit_prefetch_downloads
        if explicit_prefetch_downloads is not None
        else _env_bool("PREFETCH_DOWNLOADS", True)
    )
    whisper_profile = (
        explicit_whisper_profile or os.getenv("WHISPER_PROFILE", "balanced")
    ).strip().lower()
    whisper_retry_model = (
        explicit_whisper_retry_model or os.getenv("WHISPER_RETRY_MODEL", "medium")
    ).strip()
    whisper_vad_filter = (
        explicit_whisper_vad_filter
        if explicit_whisper_vad_filter is not None
        else _env_bool("WHISPER_VAD_FILTER", True)
    )
    whisper_max_retry_fraction = (
        explicit_whisper_max_retry_fraction
        if explicit_whisper_max_retry_fraction is not None
        else float(os.getenv("WHISPER_MAX_RETRY_FRACTION", "0.25"))
    )
    if codex_timeout_seconds <= 0:
        raise ValueError("CODEX_TIMEOUT_SECONDS must be greater than zero.")
    if max_slide_images < 0:
        raise ValueError("MAX_SLIDE_IMAGES cannot be negative.")
    if video_frame_interval_seconds <= 0:
        raise ValueError("VIDEO_FRAME_INTERVAL_SECONDS must be greater than zero.")
    if max_video_frames < 0:
        raise ValueError("MAX_VIDEO_FRAMES cannot be negative.")
    if max_total_images < 0:
        raise ValueError("MAX_TOTAL_IMAGES cannot be negative.")
    if whisper_profile not in {"fast", "balanced", "accurate"}:
        raise ValueError("WHISPER_PROFILE must be 'fast', 'balanced', or 'accurate'.")
    if not whisper_retry_model:
        raise ValueError("WHISPER_RETRY_MODEL cannot be empty.")
    if not 0 <= whisper_max_retry_fraction <= 1:
        raise ValueError("WHISPER_MAX_RETRY_FRACTION must be between zero and one.")

    return AppConfig(
        poliwebex_path=Path(env_path).expanduser().resolve(),
        whisper_model=whisper_model,
        whisper_language=whisper_language,
        whisper_num_cores=whisper_num_cores,
        top_k_matches=top_k,
        notes_mode=notes_mode,
        notes_provider=notes_provider,
        codex_bin=codex_bin,
        codex_model=codex_model,
        codex_reasoning_effort=codex_reasoning_effort,
        codex_timeout_seconds=codex_timeout_seconds,
        antigravity_bin=os.getenv("ANTIGRAVITY_BIN", "agy").strip() or "agy",
        antigravity_model=(
            explicit_antigravity_model
            if explicit_antigravity_model is not None
            else os.getenv("ANTIGRAVITY_MODEL", "")
        ).strip(),
        claude_bin=claude_bin,
        claude_model=claude_model,
        max_slide_images=max_slide_images,
        video_frames_enabled=video_frames_enabled,
        video_frame_interval_seconds=video_frame_interval_seconds,
        max_video_frames=max_video_frames,
        max_total_images=max_total_images,
        prefetch_downloads=prefetch_downloads,
        whisper_profile=whisper_profile,
        whisper_retry_model=whisper_retry_model,
        whisper_vad_filter=whisper_vad_filter,
        whisper_max_retry_fraction=whisper_max_retry_fraction,
    )


def _env_bool(key: str, default: bool) -> bool:
    value = os.getenv(key)
    if value is None or not value.strip():
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ValueError(f"{key} must be a boolean value.")
