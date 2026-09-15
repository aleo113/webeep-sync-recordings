from __future__ import annotations

import logging
import json
import re
import hashlib
import threading
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .config import AppConfig
from .models import LectureArtifacts, TranscriptResult
from .pdf_discovery import find_pdf_files
from .poliwebex_runner import PoliWebexRunner
from .notes_generator import generate_notes_markdown, write_notes_markdown
from .prompt_pack import load_transcript_files, write_metadata, write_prompt_pack, write_transcript_files
from .retrieval import build_pdf_page_contexts, rank_pdf_pages
from .transcribe import build_course_hotwords, transcribe_media

LOGGER = logging.getLogger(__name__)
PROJECT_ROOT = Path(__file__).resolve().parent.parent
INTERMEDIATE_ROOT = PROJECT_ROOT / "artifacts"


@dataclass
class _LectureJob:
    index: int
    url: str
    lecture_id: str
    download_dir: Path
    processed_dir: Path
    transcript: TranscriptResult | None
    transcript_txt: Path
    transcript_json: Path
    media_file: Path


def run_pipeline(
    urls: list[str],
    materials_root: Path,
    output_root: Path,
    config: AppConfig,
    retry_interval: int,
    skip_keyring: bool,
) -> list[LectureArtifacts]:
    if not urls:
        raise ValueError("No lecture URLs provided.")

    output_root = output_root.expanduser().resolve()
    intermediate_root = INTERMEDIATE_ROOT.resolve()
    try:
        output_root.relative_to(intermediate_root)
    except ValueError:
        pass
    else:
        raise ValueError(
            f"Output folder must be separate from the repository artifacts folder: {output_root}"
        )

    output_root.mkdir(parents=True, exist_ok=True)
    # The output root is an Obsidian vault: keep only notes and shared assets
    # there. All downloads, transcripts, metadata, logs, and prompt packs live
    # in the repository's artifacts directory instead.
    downloads_dir = intermediate_root / "downloads"
    processed_dir = intermediate_root / "processed"
    prompt_dir = intermediate_root / "prompt_packs"
    notes_dir = output_root
    notes_assets_dir = output_root / "assets"
    metadata_dir = intermediate_root / "metadata"
    visual_artifacts_dir = intermediate_root / "visuals"
    video_frame_artifacts_dir = intermediate_root / "video_frames"

    # Read the two older output-relative layouts as compatibility fallbacks.
    # New downloads and all newly written intermediate files use artifacts/.
    legacy_roots = [output_root / "Transcriber", output_root]
    legacy_downloads_dirs = [root / "downloads" for root in legacy_roots]
    legacy_processed_dirs = [root / "processed" for root in legacy_roots]
    legacy_metadata_dirs = [root / "metadata" for root in legacy_roots]

    downloader = PoliWebexRunner(config.poliwebex_path)
    downloader.validate_environment()

    used_lecture_ids: set[str] = set()
    jobs: list[_LectureJob] = []
    for index, url in enumerate(urls, start=1):
        lecture_id = _lecture_id_from_url(url, index, used_lecture_ids)
        download_dir = downloads_dir / lecture_id
        processed_job_dir = processed_dir / lecture_id
        transcript_txt = processed_job_dir / "transcript.txt"
        transcript_json = processed_job_dir / "transcript.json"
        transcript = None
        transcript_candidates = [(transcript_txt, transcript_json)]
        transcript_candidates.extend(
            (
                legacy_processed_dir / lecture_id / "transcript.txt",
                legacy_processed_dir / lecture_id / "transcript.json",
            )
            for legacy_processed_dir in legacy_processed_dirs
        )
        for candidate_txt, candidate_json in transcript_candidates:
            transcript = load_transcript_files(candidate_txt, candidate_json)
            if transcript is not None:
                transcript_txt, transcript_json = candidate_txt, candidate_json
                break

        media_file = _load_cached_media_file(
            metadata_paths=[
                metadata_dir / f"{lecture_id}.json",
                *[directory / f"{lecture_id}.json" for directory in legacy_metadata_dirs],
            ],
            download_dirs=[
                download_dir,
                *[directory / lecture_id for directory in legacy_downloads_dirs],
            ],
        )
        jobs.append(
            _LectureJob(
                index=index,
                url=url,
                lecture_id=lecture_id,
                download_dir=download_dir,
                processed_dir=processed_job_dir,
                transcript=transcript,
                transcript_txt=transcript_txt,
                transcript_json=transcript_json,
                media_file=media_file,
            )
        )

    cancel_downloads = threading.Event()
    download_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="lecture-download")
    download_future: Future[Path] | None = None
    download_job_index: int | None = None

    def schedule_next_download(start_index: int) -> None:
        nonlocal download_future, download_job_index
        if not config.prefetch_downloads or download_future is not None:
            return
        for candidate_index in range(start_index, len(jobs)):
            candidate = jobs[candidate_index]
            if candidate.transcript is not None or candidate.media_file.is_file():
                continue
            LOGGER.info(
                "[%d/%d] Prefetching recording while other work continues: %s",
                candidate.index,
                len(jobs),
                candidate.lecture_id,
            )
            download_job_index = candidate_index
            download_future = download_executor.submit(
                downloader.download_single,
                candidate.url,
                candidate.download_dir,
                retry_interval,
                skip_keyring,
                cancel_downloads,
            )
            return

    schedule_next_download(0)

    try:
        pdf_files = find_pdf_files(materials_root)
        LOGGER.info("Found %d PDF files in materials folder", len(pdf_files))
        pdf_page_contexts = build_pdf_page_contexts(pdf_files)
        LOGGER.info("Built %d PDF pages for prompt context", len(pdf_page_contexts))
        course_hotwords = build_course_hotwords(pdf_page_contexts)
        if course_hotwords:
            LOGGER.info(
                "Prepared %d course-vocabulary hints for transcription.",
                len(course_hotwords.split(", ")),
            )
    except Exception:
        cancel_downloads.set()
        if download_future is not None:
            download_future.cancel()
        download_executor.shutdown(wait=True, cancel_futures=True)
        raise

    results: list[LectureArtifacts] = []
    used_note_names: set[str] = set()

    try:
        for job_index, job in enumerate(jobs):
            lecture_id = job.lecture_id
            url = job.url
            transcript = job.transcript
            transcript_txt = job.transcript_txt
            transcript_json = job.transcript_json
            media_file = job.media_file
            LOGGER.info("[%d/%d] Processing lecture %s", job.index, len(jobs), lecture_id)

            if transcript is None:
                if not media_file.is_file():
                    if download_future is not None and download_job_index == job_index:
                        media_file = download_future.result()
                        download_future = None
                        download_job_index = None
                    else:
                        media_file = downloader.download_single(
                            url=url,
                            output_dir=job.download_dir,
                            retry_interval=retry_interval,
                            skip_keyring=skip_keyring,
                        )
                schedule_next_download(job_index + 1)

                transcript = transcribe_media(
                    media_path=media_file,
                    model_size=config.whisper_model,
                    language=config.whisper_language,
                    num_cores=config.whisper_num_cores,
                    hotwords=course_hotwords or None,
                    profile=config.whisper_profile,
                    retry_model_size=config.whisper_retry_model,
                    vad_filter=config.whisper_vad_filter,
                    max_retry_fraction=config.whisper_max_retry_fraction,
                )

                transcript_txt, transcript_json = write_transcript_files(transcript, job.processed_dir)
            else:
                LOGGER.info("Reusing cached transcript for lecture %s", lecture_id)

            matches = rank_pdf_pages(
                query_text=transcript.full_text,
                pages=pdf_page_contexts,
                top_k=config.top_k_matches,
            )
            page_contexts = _page_contexts_for_matches(pdf_page_contexts, matches)

            prompt_markdown: Path | None = None
            notes_markdown: Path | None = None

            if config.notes_mode == "prompt-pack":
                prompt_markdown = prompt_dir / f"{lecture_id}.md"
                write_prompt_pack(
                    lecture_id=lecture_id,
                    source_url=url,
                    transcript=transcript,
                    page_contexts=page_contexts,
                    prompt_path=prompt_markdown,
                )
            elif config.notes_mode == "api":
                note_name = _note_filename(media_file, lecture_id, used_note_names)
                notes_markdown = notes_dir / note_name
                frames_available = media_file.is_file()
                if config.video_frames_enabled and not frames_available:
                    LOGGER.warning(
                        "Cached transcript found but its recording is unavailable; "
                        "video frames will be skipped for lecture %s.",
                        lecture_id,
                    )
                LOGGER.info(
                    "[%d/%d] Preparing visual context for lecture %s.",
                    job.index,
                    len(jobs),
                    lecture_id,
                )
                generated_notes = generate_notes_markdown(
                    lecture_id=lecture_id,
                    source_url=url,
                    transcript=transcript,
                    page_contexts=page_contexts,
                    matches=matches,
                    notes_assets_dir=notes_assets_dir,
                    notes_provider=config.notes_provider,
                    codex_bin=config.codex_bin,
                    codex_model=config.codex_model,
                    codex_reasoning_effort=config.codex_reasoning_effort,
                    codex_timeout_seconds=config.codex_timeout_seconds,
                    antigravity_bin=config.antigravity_bin,
                    antigravity_model=config.antigravity_model,
                    claude_bin=config.claude_bin,
                    claude_model=config.claude_model,
                    max_images=config.max_slide_images,
                    media_path=media_file if frames_available else None,
                    visual_artifacts_dir=visual_artifacts_dir / lecture_id,
                    video_frame_artifacts_dir=video_frame_artifacts_dir / lecture_id,
                    video_frames_enabled=config.video_frames_enabled and frames_available,
                    video_frame_interval_seconds=config.video_frame_interval_seconds,
                    max_video_frames=config.max_video_frames,
                    max_total_images=config.max_total_images,
                )
                LOGGER.info(
                    "%s finished for lecture %s; writing the final note.",
                    config.notes_provider.capitalize(),
                    lecture_id,
                )
                write_notes_markdown(generated_notes, notes_markdown)
                LOGGER.info("Final note created: %s", notes_markdown)

            metadata_json = metadata_dir / f"{lecture_id}.json"

            artifacts = LectureArtifacts(
                lecture_id=lecture_id,
                source_url=url,
                media_file=media_file,
                transcript_txt=transcript_txt,
                transcript_json=transcript_json,
                prompt_markdown=prompt_markdown,
                notes_markdown=notes_markdown,
                metadata_json=metadata_json,
            )

            write_metadata(
                artifacts=artifacts,
                matches=matches,
                metadata_path=metadata_json,
                notes_model=(
                    {
                        "codex": config.codex_model,
                        "claude": config.claude_model,
                        "antigravity": config.antigravity_model or "CLI default",
                    }[config.notes_provider]
                    if config.notes_mode == "api"
                    else None
                ),
                notes_provider=f"{config.notes_provider}-cli",
                notes_reasoning_effort=(
                    config.codex_reasoning_effort
                    if config.notes_mode == "api" and config.notes_provider == "codex"
                    else None
                ),
                visual_context_path=(
                    visual_artifacts_dir / lecture_id / "visual_context.json"
                    if config.notes_mode == "api"
                    else None
                ),
                transcription_settings={
                    "profile": config.whisper_profile,
                    "primary_model": config.whisper_model,
                    "effective_primary_model": (
                        config.whisper_retry_model
                        if config.whisper_profile == "accurate"
                        else config.whisper_model
                    ),
                    "retry_model": config.whisper_retry_model,
                    "vad_filter": config.whisper_vad_filter,
                    "max_retry_fraction": config.whisper_max_retry_fraction,
                    "course_hotword_count": len(course_hotwords.split(", "))
                    if course_hotwords
                    else 0,
                    "cached_transcript_reused": job.transcript is not None,
                },
            )
            results.append(artifacts)
    except Exception:
        cancel_downloads.set()
        if download_future is not None:
            download_future.cancel()
        raise
    finally:
        download_executor.shutdown(wait=True, cancel_futures=True)

    return results


def _note_filename(media_file: Path, lecture_id: str, used_names: set[str]) -> str:
    """Return a readable, filesystem-safe note name while retaining uniqueness."""
    stem = media_file.stem.strip() if media_file else ""
    if not stem or stem.lower() in {"media", "audio", "video"}:
        stem = f"Lecture {lecture_id}"

    # Downloaded WebEx files commonly end with a recording timestamp and a
    # stream suffix. Those details are useful in metadata but make poor note
    # titles, so remove only that well-known trailing pattern.
    stem = re.sub(r"[-_ ]+\d{8}\s+\d{3,4}(?:[-_]\d+)?$", "", stem).strip(" -_")
    stem = re.sub(r"['’]s\s+Personal\s+Room\s*$", "", stem, flags=re.IGNORECASE)
    stem = re.sub(r"[<>:\"/\\|?*]+", "-", stem)
    stem = re.sub(r"\s+", " ", stem).strip(" .-")
    if not stem:
        stem = f"Lecture {lecture_id}"

    base = stem[:140]
    candidate = f"{base}.md"
    suffix = 2
    while candidate in used_names:
        suffix_text = f" ({suffix})"
        candidate = f"{base[:140 - len(suffix_text)]}{suffix_text}.md"
        suffix += 1
    used_names.add(candidate)
    return candidate


def _lecture_id_from_url(url: str, index: int, used_ids: set[str]) -> str:
    parsed = urlparse(url)
    query = parse_qs(parsed.query)

    generic_tokens = {
        "playback",
        "recording",
        "recordings",
        "recordingservice",
        "sites",
        "site",
    }

    token_candidates: list[str] = []
    for key in ("recordingId", "recordingid", "rcid", "id", "uuid", "meetingId", "meetingid"):
        values = query.get(key)
        if values and values[0].strip():
            token_candidates.append(values[0].strip())

    path_tokens = [t for t in parsed.path.split("/") if t]
    for token in reversed(path_tokens):
        cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", token).strip("-")
        if cleaned and cleaned.lower() not in generic_tokens:
            token_candidates.append(cleaned)
            break

    if parsed.fragment.strip():
        token_candidates.append(parsed.fragment.strip())

    base = ""
    for candidate in token_candidates:
        cleaned = re.sub(r"[^a-zA-Z0-9_-]+", "-", candidate).strip("-")
        if cleaned:
            base = cleaned
            break

    if not base:
        base = f"lecture-{index}"

    if base.lower() in generic_tokens:
        url_hash = hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]
        base = f"{base}-{url_hash}"

    lecture_id = base[:80]
    if lecture_id not in used_ids:
        used_ids.add(lecture_id)
        return lecture_id

    suffix = 2
    while True:
        suffix_str = f"-{suffix}"
        max_base_len = 80 - len(suffix_str)
        candidate = f"{base[:max_base_len]}{suffix_str}"
        if candidate not in used_ids:
            used_ids.add(candidate)
            return candidate
        suffix += 1


def _load_cached_media_file(metadata_paths: list[Path], download_dirs: list[Path]) -> Path:
    for metadata_path in metadata_paths:
        if not metadata_path.is_file():
            continue
        try:
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            media_file = payload.get("media_file")
            if isinstance(media_file, str) and media_file.strip():
                return Path(media_file)
        except Exception:
            continue

    for download_dir in download_dirs:
        if not download_dir.exists():
            continue
        candidates = sorted(
            [candidate for candidate in download_dir.iterdir() if candidate.is_file()],
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        if candidates:
            return candidates[0]

    return download_dirs[0] / "media"


def _page_contexts_for_matches(page_contexts, matches):
    selected = []
    seen: set[tuple[str, int]] = set()

    for match in matches:
        target = (str(match.chunk.source_path), match.chunk.page_number)
        if target in seen:
            continue
        seen.add(target)

        for page in page_contexts:
            if str(page.source_path) == str(match.chunk.source_path) and page.page_number == match.chunk.page_number:
                selected.append(page)
                break

    return selected
