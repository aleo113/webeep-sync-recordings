from __future__ import annotations

import os
from pathlib import Path

from .models import TranscriptResult, TranscriptSegment


def transcribe_media(
    media_path: Path,
    model_size: str,
    language: str | None = None,
    num_cores: int | None = None,
) -> TranscriptResult:
    # Many CPU-backed libraries honor thread limits from environment variables.
    thread_env_vars = [
        "OMP_NUM_THREADS",
        "OPENBLAS_NUM_THREADS",
        "MKL_NUM_THREADS",
        "VECLIB_MAXIMUM_THREADS",
        "NUMEXPR_NUM_THREADS",
    ]
    saved_env = {key: os.environ.get(key) for key in thread_env_vars}
    try:
        if num_cores is not None and num_cores > 0:
            for key in thread_env_vars:
                os.environ[key] = str(num_cores)

        from faster_whisper import WhisperModel  # type: ignore

        model = WhisperModel(model_size)
        transcribe_kwargs = {"language": language} if language is not None else {}
        segments, info = model.transcribe(str(media_path), **transcribe_kwargs)
    finally:
        for key, value in saved_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    extracted_segments: list[TranscriptSegment] = []
    text_parts: list[str] = []

    for segment in segments:
        segment_text = (segment.text or "").strip()
        if not segment_text:
            continue
        extracted_segments.append(
            TranscriptSegment(
                start=float(segment.start),
                end=float(segment.end),
                text=segment_text,
            )
        )
        text_parts.append(segment_text)

    full_text = "\n".join(text_parts).strip()
    return TranscriptResult(language=getattr(info, "language", "unknown"), full_text=full_text, segments=extracted_segments)
