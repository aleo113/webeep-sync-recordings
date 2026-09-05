from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
from collections import Counter
from pathlib import Path
from typing import Any, Callable

from .models import PdfPageContext, TranscriptResult, TranscriptSegment

LOGGER = logging.getLogger(__name__)
_MODEL_CACHE: dict[tuple[str, int, str, str], Any] = {}
_MODEL_CACHE_LOCK = threading.Lock()
_TECHNICAL_TOKEN = re.compile(
    r"\b(?:[A-Z][A-Z0-9_-]{1,}|[A-Z][a-z]+(?:[A-Z][A-Za-z0-9]*)+|"
    r"[A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,3})\b"
)
_GLOSSARY_STOPWORDS = {
    "Abstract",
    "Chapter",
    "Contents",
    "Example",
    "Exercise",
    "Figure",
    "Introduction",
    "Lecture",
    "Lesson",
    "Page",
    "References",
    "Section",
    "Summary",
    "Table",
}


def build_course_hotwords(pages: list[PdfPageContext], max_characters: int = 1200) -> str:
    """Build a compact technical glossary from already-extracted course materials."""
    scores: Counter[str] = Counter()
    seen_files: set[Path] = set()
    for page in pages:
        if page.source_path not in seen_files:
            seen_files.add(page.source_path)
            stem = re.sub(r"[_-]+", " ", page.source_path.stem)
            stem = re.sub(r"\s+", " ", stem).strip()
            if 2 <= len(stem) <= 100:
                scores[stem] += 8
        for match in _TECHNICAL_TOKEN.finditer(page.combined_text[:12000]):
            term = re.sub(r"\s+", " ", match.group(0)).strip()
            if term not in _GLOSSARY_STOPWORDS and 2 <= len(term) <= 80:
                scores[term] += 1

    selected: list[str] = []
    used = 0
    for term, _score in sorted(scores.items(), key=lambda item: (-item[1], item[0].lower())):
        addition = len(term) + (2 if selected else 0)
        if used + addition > max_characters:
            continue
        selected.append(term)
        used += addition
    return ", ".join(selected)


def transcribe_media(
    media_path: Path,
    model_size: str,
    language: str | None = None,
    num_cores: int | None = None,
    on_progress: Callable[[float], None] | None = None,
    hotwords: str | None = None,
    profile: str = "balanced",
    retry_model_size: str = "medium",
    vad_filter: bool = True,
    max_retry_fraction: float = 0.25,
) -> TranscriptResult:
    """Transcribe lecture media with course hints and bounded confidence retry."""
    normalized_profile = profile.strip().lower()
    if normalized_profile not in {"fast", "balanced", "accurate"}:
        raise ValueError("Transcription profile must be 'fast', 'balanced', or 'accurate'.")
    if not 0 <= max_retry_fraction <= 1:
        raise ValueError("Maximum transcription retry fraction must be between 0 and 1.")

    primary_model_size = retry_model_size if normalized_profile == "accurate" else model_size
    model = _get_model(primary_model_size, num_cores)
    prompt = _initial_prompt(language)
    progress_scale = 0.85 if normalized_profile == "balanced" else 1.0
    segments, detected_language, duration = _transcribe_once(
        model=model,
        media_path=media_path,
        language=language,
        hotwords=hotwords,
        initial_prompt=prompt,
        vad_filter=vad_filter,
        on_progress=(
            (lambda fraction: on_progress(fraction * progress_scale))
            if on_progress
            else None
        ),
    )

    if normalized_profile == "balanced" and segments and max_retry_fraction > 0:
        effective_duration = duration or max(segment.end for segment in segments)
        windows = _uncertain_windows(segments, effective_duration, max_retry_fraction)
        if windows:
            LOGGER.info(
                "Retrying %d uncertain transcription region(s) with model %s.",
                len(windows),
                retry_model_size,
            )
            try:
                retry_model = _get_model(retry_model_size, num_cores)
                segments = _retry_windows(
                    media_path=media_path,
                    segments=segments,
                    windows=windows,
                    model=retry_model,
                    language=language or detected_language,
                    hotwords=hotwords,
                    initial_prompt=prompt,
                    vad_filter=vad_filter,
                    on_progress=on_progress,
                )
            except Exception as exc:
                LOGGER.warning(
                    "Selective transcription retry failed; keeping the primary transcript: %s",
                    exc,
                )

    if on_progress:
        on_progress(1.0)
    segments.sort(key=lambda segment: (segment.start, segment.end))
    full_text = "\n".join(segment.text for segment in segments if segment.text).strip()
    return TranscriptResult(
        language=detected_language or language or "unknown",
        full_text=full_text,
        segments=segments,
    )


def _get_model(model_size: str, num_cores: int | None) -> Any:
    cpu_threads = num_cores if num_cores is not None and num_cores > 0 else 0
    device, compute_type = _runtime_backend()
    key = (model_size, cpu_threads, device, compute_type)
    with _MODEL_CACHE_LOCK:
        cached = _MODEL_CACHE.get(key)
        if cached is not None:
            return cached
        from faster_whisper import WhisperModel  # type: ignore

        LOGGER.info(
            "Loading faster-whisper model %s (device=%s, compute=%s, cpu_threads=%s).",
            model_size,
            device,
            compute_type,
            cpu_threads or "auto",
        )
        model = WhisperModel(
            model_size,
            device=device,
            compute_type=compute_type,
            cpu_threads=cpu_threads,
        )
        _MODEL_CACHE[key] = model
        return model


def clear_model_cache() -> None:
    """Release cached model references, primarily for tests and embedding applications."""
    with _MODEL_CACHE_LOCK:
        _MODEL_CACHE.clear()


def _runtime_backend() -> tuple[str, str]:
    configured_device = os.getenv("WHISPER_DEVICE", "").strip()
    configured_compute = os.getenv("WHISPER_COMPUTE_TYPE", "").strip()
    if configured_device and configured_compute:
        return configured_device, configured_compute
    try:
        import ctranslate2  # type: ignore

        has_cuda = ctranslate2.get_cuda_device_count() > 0
    except Exception:
        has_cuda = False
    device = configured_device or ("cuda" if has_cuda else "cpu")
    compute_type = configured_compute or ("float16" if device == "cuda" else "int8")
    return device, compute_type


def _transcribe_once(
    model: Any,
    media_path: Path,
    language: str | None,
    hotwords: str | None,
    initial_prompt: str | None,
    vad_filter: bool,
    on_progress: Callable[[float], None] | None,
    offset: float = 0.0,
) -> tuple[list[TranscriptSegment], str, float]:
    kwargs: dict[str, object] = {
        "beam_size": 5,
        "vad_filter": vad_filter,
        "condition_on_previous_text": True,
    }
    if language:
        kwargs["language"] = language
    else:
        kwargs["language_detection_segments"] = 3
    # faster-whisper budgets hotwords independently from previous transcript
    # tokens. Once both reach half of Whisper's 448-token context, the prompt can
    # leave no room for decoding. Supplying the course vocabulary as the initial
    # prompt instead keeps it on faster-whisper's bounded history path.
    if hotwords:
        kwargs["initial_prompt"] = hotwords
    elif initial_prompt:
        kwargs["initial_prompt"] = initial_prompt

    source_segments, info = model.transcribe(str(media_path), **kwargs)
    duration = float(getattr(info, "duration", 0.0) or 0.0)
    extracted: list[TranscriptSegment] = []
    for segment in source_segments:
        text = (getattr(segment, "text", "") or "").strip()
        if not text:
            continue
        extracted.append(
            TranscriptSegment(
                start=offset + float(segment.start),
                end=offset + float(segment.end),
                text=text,
                avg_logprob=_optional_float(getattr(segment, "avg_logprob", None)),
                no_speech_prob=_optional_float(getattr(segment, "no_speech_prob", None)),
                compression_ratio=_optional_float(getattr(segment, "compression_ratio", None)),
            )
        )
        if on_progress and duration > 0:
            on_progress(min(1.0, max(0.0, float(segment.end) / duration)))
    return extracted, str(getattr(info, "language", language or "unknown")), duration


def _uncertain_windows(
    segments: list[TranscriptSegment], duration: float, max_retry_fraction: float
) -> list[tuple[float, float, float]]:
    uncertain: list[tuple[float, float, float]] = []
    for segment in segments:
        uncertainty = _uncertainty_score(segment)
        if uncertainty <= 0:
            continue
        uncertain.append(
            (
                max(0.0, segment.start - 2.0),
                min(duration, segment.end + 2.0) if duration > 0 else segment.end + 2.0,
                uncertainty,
            )
        )
    if not uncertain:
        return []

    uncertain.sort(key=lambda window: window[0])
    merged: list[list[float]] = []
    for start, end, score in uncertain:
        if merged and start <= merged[-1][1] + 1.0:
            merged[-1][1] = max(merged[-1][1], end)
            merged[-1][2] = max(merged[-1][2], score)
        else:
            merged.append([start, end, score])

    retry_budget = min(900.0, max(0.0, duration * max_retry_fraction))
    selected: list[tuple[float, float, float]] = []
    consumed = 0.0
    for start, end, score in sorted(merged, key=lambda window: window[2], reverse=True):
        window_duration = max(0.0, end - start)
        if window_duration == 0 or consumed + window_duration > retry_budget:
            continue
        selected.append((start, end, score))
        consumed += window_duration
    return sorted(selected, key=lambda window: window[0])


def _uncertainty_score(segment: TranscriptSegment) -> float:
    score = 0.0
    if segment.avg_logprob is not None and segment.avg_logprob < -0.75:
        score = max(score, -0.75 - segment.avg_logprob)
    if segment.compression_ratio is not None and segment.compression_ratio > 2.2:
        score = max(score, segment.compression_ratio - 2.2)
    if segment.no_speech_prob is not None and segment.no_speech_prob > 0.65:
        score = max(score, segment.no_speech_prob - 0.65)
    return score


def _retry_windows(
    media_path: Path,
    segments: list[TranscriptSegment],
    windows: list[tuple[float, float, float]],
    model: Any,
    language: str | None,
    hotwords: str | None,
    initial_prompt: str | None,
    vad_filter: bool,
    on_progress: Callable[[float], None] | None,
) -> list[TranscriptSegment]:
    ffmpeg = _resolve_ffmpeg()
    if ffmpeg is None:
        raise RuntimeError("ffmpeg is required for selective transcription retry.")
    updated = list(segments)
    with tempfile.TemporaryDirectory(prefix="transcriber-retry-") as directory:
        temp_root = Path(directory)
        for index, (start, end, _score) in enumerate(windows, start=1):
            clip_path = temp_root / f"clip-{index}.wav"
            _extract_audio_clip(ffmpeg, media_path, start, end, clip_path)
            retry_segments, _detected, _duration = _transcribe_once(
                model=model,
                media_path=clip_path,
                language=language,
                hotwords=hotwords,
                initial_prompt=initial_prompt,
                vad_filter=vad_filter,
                on_progress=None,
                offset=start,
            )
            original_segments = [
                segment
                for segment in updated
                if segment.end > start and segment.start < end
            ]
            if retry_segments and _mean_quality(retry_segments) >= _mean_quality(original_segments):
                updated = [
                    segment
                    for segment in updated
                    if segment.end <= start or segment.start >= end
                ]
                updated.extend(retry_segments)
            if on_progress:
                on_progress(0.85 + 0.15 * index / len(windows))
    return updated


def _mean_quality(segments: list[TranscriptSegment]) -> float:
    if not segments:
        return float("-inf")
    values = []
    for segment in segments:
        log_probability = segment.avg_logprob if segment.avg_logprob is not None else -1.0
        no_speech_penalty = max(0.0, (segment.no_speech_prob or 0.0) - 0.5)
        repetition_penalty = max(0.0, (segment.compression_ratio or 1.0) - 2.0) * 0.25
        values.append(log_probability - no_speech_penalty - repetition_penalty)
    return sum(values) / len(values)


def _extract_audio_clip(
    ffmpeg: Path, media_path: Path, start: float, end: float, output_path: Path
) -> None:
    result = subprocess.run(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{start:.3f}",
            "-i",
            str(media_path),
            "-t",
            f"{max(0.1, end - start):.3f}",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "16000",
            "-c:a",
            "pcm_s16le",
            "-y",
            str(output_path),
        ],
        capture_output=True,
        check=False,
        timeout=max(60, int(end - start) * 2),
    )
    if result.returncode != 0 or not output_path.is_file():
        error = result.stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"Could not extract uncertain audio region: {error}")


def _resolve_ffmpeg() -> Path | None:
    configured = os.getenv("FFMPEG_BIN", "").strip()
    if configured:
        candidate = Path(configured).expanduser().resolve()
        if candidate.is_file() and os.access(candidate, os.X_OK):
            return candidate
    resolved = shutil.which("ffmpeg")
    return Path(resolved).resolve() if resolved else None


def _initial_prompt(language: str | None) -> str:
    language_description = f" in language {language}" if language else ""
    return (
        f"University lecture{language_description}. Preserve technical terminology, acronyms, "
        "mathematical names, punctuation, and complete sentences."
    )


def _optional_float(value: object) -> float | None:
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None
