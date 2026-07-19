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
    explicit_codex_model: str | None = None,
    explicit_codex_reasoning_effort: str | None = None,
) -> AppConfig:
    env_path = explicit_poliwebex_path or os.getenv("POLIWEBEX_PATH", "") or _read_env_file_value("POLIWEBEX_PATH")
    if not env_path:
        raise ValueError("PoliWebex path is required. Pass --poliwebex-path or set POLIWEBEX_PATH.")

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
    codex_bin = os.getenv("CODEX_BIN", "codex").strip() or "codex"
    codex_model = (explicit_codex_model or os.getenv("CODEX_MODEL", "gpt-5.6-luna")).strip()
    codex_reasoning_effort = (
        explicit_codex_reasoning_effort or os.getenv("CODEX_REASONING_EFFORT", "high")
    ).strip().lower()
    if codex_reasoning_effort not in {"none", "minimal", "low", "medium", "high", "xhigh", "max"}:
        raise ValueError(
            "CODEX_REASONING_EFFORT must be one of: none, minimal, low, medium, high, xhigh, max."
        )
    codex_timeout_seconds = int(os.getenv("CODEX_TIMEOUT_SECONDS", "900"))
    max_slide_images = int(os.getenv("MAX_SLIDE_IMAGES", "8"))
    if codex_timeout_seconds <= 0:
        raise ValueError("CODEX_TIMEOUT_SECONDS must be greater than zero.")
    if max_slide_images < 0:
        raise ValueError("MAX_SLIDE_IMAGES cannot be negative.")

    return AppConfig(
        poliwebex_path=Path(env_path).expanduser().resolve(),
        whisper_model=whisper_model,
        whisper_language=whisper_language,
        whisper_num_cores=whisper_num_cores,
        top_k_matches=top_k,
        notes_mode=notes_mode,
        codex_bin=codex_bin,
        codex_model=codex_model,
        codex_reasoning_effort=codex_reasoning_effort,
        codex_timeout_seconds=codex_timeout_seconds,
        max_slide_images=max_slide_images,
    )
