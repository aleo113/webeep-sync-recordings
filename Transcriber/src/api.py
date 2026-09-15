from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from .models import LectureArtifacts
from .notes_generator import generate_notes_markdown, write_notes_markdown
from .pdf_discovery import find_pdf_files
from .pipeline import _page_contexts_for_matches
from .poliwebex_runner import PoliWebexRunner
from .prompt_pack import write_metadata, write_prompt_pack, write_transcript_files
from .retrieval import build_pdf_page_contexts, rank_pdf_pages
from .transcribe import build_course_hotwords, transcribe_media

ProgressCallback = Callable[["ProgressEvent"], None]
CancelCheck = Callable[[], bool]


class TranscriberError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


class TranscriptionCancelled(TranscriberError):
    def __init__(self) -> None:
        super().__init__("CANCELLED", "Transcription job was cancelled.")


@dataclass(frozen=True)
class ProgressEvent:
    stage: str
    fraction: float | None
    message: str


@dataclass(frozen=True)
class ProcessOptions:
    workspace_root: Path
    output_root: Path
    materials_root: Path | None = None
    source_url: str = ""
    lecture_id: str | None = None
    whisper_model: str = "small"
    whisper_language: str | None = None
    whisper_num_cores: int | None = None
    notes_mode: str = "transcript-only"
    notes_provider: str = "codex"
    top_k_matches: int = 12
    codex_bin: str = "codex"
    codex_model: str = "gpt-5.6-luna"
    codex_reasoning_effort: str = "high"
    codex_timeout_seconds: int = 900
    claude_bin: str = "claude"
    claude_model: str = "sonnet"
    max_slide_images: int = 8
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


def download_recording(
    url: str,
    output_dir: Path,
    poliwebex_path: Path,
    retry_interval: int = 1,
    skip_keyring: bool = False,
    on_progress: ProgressCallback | None = None,
    spid_username: str | None = None,
    spid_password: str | None = None,
    polimi_email: str | None = None,
) -> Path:
    """Download one recording through the configured PoliWebex installation."""
    if not url.startswith(("http://", "https://")):
        raise TranscriberError("INVALID_URL", "Recording URL must use HTTP or HTTPS.")
    if on_progress:
        on_progress(ProgressEvent("downloading", 0.0, "Starting PoliWebex"))
    try:
        runner = PoliWebexRunner(poliwebex_path.expanduser().resolve())
        runner.validate_environment()
        media_path = runner.download_single(
            url=url,
            output_dir=output_dir.expanduser().resolve(),
            retry_interval=retry_interval,
            skip_keyring=skip_keyring,
            spid_username=spid_username,
            spid_password=spid_password,
            polimi_email=polimi_email,
        )
    except Exception as exc:
        raise TranscriberError("DOWNLOAD_FAILED", str(exc)) from exc
    if on_progress:
        on_progress(ProgressEvent("downloading", 1.0, "Download complete"))
    return media_path


def process_media(
    media_path: Path,
    options: ProcessOptions,
    on_progress: ProgressCallback | None = None,
    is_cancelled: CancelCheck | None = None,
) -> LectureArtifacts:
    """Process an existing media file without invoking a downloader."""
    media_path = media_path.expanduser().resolve()
    if not media_path.is_file():
        raise TranscriberError("MEDIA_NOT_FOUND", f"Media file not found: {media_path}")
    if options.notes_mode not in {"transcript-only", "prompt-pack", "api"}:
        raise TranscriberError("INVALID_NOTES_MODE", f"Unsupported notes mode: {options.notes_mode}")
    if options.notes_provider not in {"codex", "claude", "antigravity"}:
        raise TranscriberError(
            "INVALID_NOTES_PROVIDER", f"Unsupported notes provider: {options.notes_provider}"
        )
    if options.video_frame_interval_seconds <= 0:
        raise TranscriberError("INVALID_OPTIONS", "Video-frame interval must be greater than zero.")
    if options.max_video_frames < 0 or options.max_total_images < 0:
        raise TranscriberError("INVALID_OPTIONS", "Visual image limits cannot be negative.")
    if options.whisper_profile not in {"fast", "balanced", "accurate"}:
        raise TranscriberError("INVALID_OPTIONS", "Invalid transcription profile.")
    if not 0 <= options.whisper_max_retry_fraction <= 1:
        raise TranscriberError("INVALID_OPTIONS", "Whisper retry fraction must be between zero and one.")

    workspace = options.workspace_root.expanduser().resolve()
    output_root = options.output_root.expanduser().resolve()
    lecture_id = options.lecture_id or _stable_lecture_id(media_path, options.source_url)
    processed_dir = workspace / "processed" / lecture_id
    metadata_path = workspace / "metadata" / f"{lecture_id}.json"
    prompt_path = workspace / "prompt_packs" / f"{lecture_id}.md"
    output_root.mkdir(parents=True, exist_ok=True)

    def emit(stage: str, fraction: float | None, message: str) -> None:
        if is_cancelled and is_cancelled():
            raise TranscriptionCancelled()
        if on_progress:
            on_progress(ProgressEvent(stage, fraction, message))

    pages = []
    course_hotwords = ""
    if options.materials_root:
        emit("materials", 0.0, "Reading course materials and preparing terminology")
        pdf_files = find_pdf_files(options.materials_root.expanduser().resolve())
        pages = build_pdf_page_contexts(pdf_files)
        course_hotwords = build_course_hotwords(pages)
        emit("materials", 1.0, f"Prepared {len(pages)} PDF pages for transcription")

    emit("transcribing", 0.0, f"Loading {options.whisper_profile} transcription profile")
    transcript = transcribe_media(
        media_path=media_path,
        model_size=options.whisper_model,
        language=options.whisper_language,
        num_cores=options.whisper_num_cores,
        hotwords=course_hotwords or None,
        profile=options.whisper_profile,
        retry_model_size=options.whisper_retry_model,
        vad_filter=options.whisper_vad_filter,
        max_retry_fraction=options.whisper_max_retry_fraction,
        on_progress=lambda fraction: emit(
            "transcribing",
            fraction,
            f"Transcribing ({fraction:.0%})",
        ),
    )
    emit("transcribing", 1.0, "Transcription complete")
    transcript_txt, transcript_json = write_transcript_files(transcript, processed_dir)

    matches = []
    page_contexts = []
    if pages:
        emit("materials", 0.0, "Matching transcript to course materials")
        matches = rank_pdf_pages(transcript.full_text, pages, options.top_k_matches)
        page_contexts = _page_contexts_for_matches(pages, matches)
        emit("materials", 1.0, f"Selected {len(page_contexts)} relevant PDF pages")

    prompt_markdown = None
    notes_markdown = None
    if options.notes_mode == "prompt-pack":
        emit("notes", 0.0, "Writing prompt pack")
        write_prompt_pack(lecture_id, options.source_url, transcript, page_contexts, prompt_path)
        prompt_markdown = prompt_path
        emit("notes", 1.0, "Prompt pack complete")
    elif options.notes_mode == "api":
        emit(
            "notes",
            0.0,
            f"Selecting visual context and invoking {options.notes_provider.capitalize()}",
        )
        notes_markdown = output_root / f"{_safe_name(media_path.stem)}.md"
        notes = generate_notes_markdown(
            lecture_id=lecture_id,
            source_url=options.source_url,
            transcript=transcript,
            page_contexts=page_contexts,
            matches=matches,
            notes_assets_dir=output_root / "assets",
            notes_provider=options.notes_provider,
            codex_bin=options.codex_bin,
            codex_model=options.codex_model,
            codex_reasoning_effort=options.codex_reasoning_effort,
            codex_timeout_seconds=options.codex_timeout_seconds,
            antigravity_bin=options.antigravity_bin,
            antigravity_model=options.antigravity_model,
            claude_bin=options.claude_bin,
            claude_model=options.claude_model,
            max_images=options.max_slide_images,
            media_path=media_path,
            visual_artifacts_dir=workspace / "visuals" / lecture_id,
            video_frame_artifacts_dir=workspace / "video_frames" / lecture_id,
            video_frames_enabled=options.video_frames_enabled,
            video_frame_interval_seconds=options.video_frame_interval_seconds,
            max_video_frames=options.max_video_frames,
            max_total_images=options.max_total_images,
        )
        write_notes_markdown(notes, notes_markdown)
        emit("notes", 1.0, f"Final note created: {notes_markdown}")

    artifacts = LectureArtifacts(
        lecture_id=lecture_id,
        source_url=options.source_url,
        media_file=media_path,
        transcript_txt=transcript_txt,
        transcript_json=transcript_json,
        prompt_markdown=prompt_markdown,
        notes_markdown=notes_markdown,
        metadata_json=metadata_path,
    )
    write_metadata(
        artifacts,
        matches,
        metadata_path,
        notes_model=(
            {
                "codex": options.codex_model,
                "claude": options.claude_model,
                "antigravity": options.antigravity_model or "CLI default",
            }[options.notes_provider]
            if options.notes_mode == "api"
            else None
        ),
        notes_provider=f"{options.notes_provider}-cli",
        notes_reasoning_effort=(
            options.codex_reasoning_effort
            if options.notes_mode == "api" and options.notes_provider == "codex"
            else None
        ),
        visual_context_path=(
            workspace / "visuals" / lecture_id / "visual_context.json"
            if options.notes_mode == "api"
            else None
        ),
        transcription_settings={
            "profile": options.whisper_profile,
            "primary_model": options.whisper_model,
            "effective_primary_model": (
                options.whisper_retry_model
                if options.whisper_profile == "accurate"
                else options.whisper_model
            ),
            "retry_model": options.whisper_retry_model,
            "vad_filter": options.whisper_vad_filter,
            "max_retry_fraction": options.whisper_max_retry_fraction,
            "course_hotword_count": len(course_hotwords.split(", "))
            if course_hotwords
            else 0,
            "cached_transcript_reused": False,
        },
    )
    emit("complete", 1.0, "Processing complete")
    return artifacts


def _stable_lecture_id(media_path: Path, source_url: str) -> str:
    seed = source_url.strip() or str(media_path)
    readable = _safe_name(media_path.stem).lower().replace(" ", "-")[:48]
    return f"{readable}-{hashlib.sha1(seed.encode('utf-8')).hexdigest()[:10]}"


def _safe_name(value: str) -> str:
    cleaned = re.sub(r'[<>:"/\\|?*]+', "-", value)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .-")
    return cleaned[:140] or "lecture"
