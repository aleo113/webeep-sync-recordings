from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
from pathlib import Path

import numpy as np

from .models import TranscriptResult

LOGGER = logging.getLogger(__name__)
SELECTOR_VERSION = 1
THUMBNAIL_WIDTH = 320
THUMBNAIL_HEIGHT = 180
MAX_REFINEMENT_PROBES = 12
MIN_SELECTED_SPACING_SECONDS = 120.0
VIDEO_EXTENSIONS = {".mp4", ".mkv", ".webm", ".mov", ".avi", ".m4v"}


def select_video_frames(
    media_path: Path,
    transcript: TranscriptResult,
    artifact_dir: Path,
    lecture_id: str,
    slide_image_paths: list[Path] | None = None,
    interval_seconds: int = 60,
    max_frames: int = 8,
) -> list[dict[str, object]]:
    """Select a small, cached set of useful lecture-video frames.

    Candidate frames are fetched with independent, fast FFmpeg seeks. This is
    deliberately cheaper than decoding the complete video or materializing a
    frame every few seconds.
    """
    media_path = media_path.expanduser().resolve()
    if max_frames <= 0 or interval_seconds <= 0:
        return []
    if media_path.suffix.lower() not in VIDEO_EXTENSIONS or not media_path.is_file():
        return []

    ffmpeg = _resolve_binary("ffmpeg", "FFMPEG_BIN")
    if ffmpeg is None:
        LOGGER.warning("Skipping video frames because ffmpeg is unavailable.")
        return []

    duration = _transcript_duration(transcript)
    if duration <= 0:
        duration = _probe_duration(media_path)
    if duration <= 0:
        LOGGER.warning(
            "Skipping video frames because the recording duration is unknown: %s", media_path
        )
        return []

    artifact_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = artifact_dir / "manifest.json"
    cache_key = _cache_key(
        media_path,
        interval_seconds,
        max_frames,
        duration,
        transcript,
        slide_image_paths or [],
    )
    cached = _load_cached_frames(manifest_path, cache_key)
    if cached is not None:
        LOGGER.info("Reusing %d cached video frames for lecture %s", len(cached), lecture_id)
        return cached

    LOGGER.info(
        "Sampling lecture video every %d seconds for visual context (maximum %d final frames).",
        interval_seconds,
        max_frames,
    )
    start = min(duration / 2.0, interval_seconds / 2.0)
    timestamps = []
    current = start
    while current < duration:
        timestamps.append(current)
        current += interval_seconds

    candidates: list[dict[str, object]] = []
    for timestamp in timestamps:
        frame = _extract_gray_frame(ffmpeg, media_path, timestamp)
        if frame is not None:
            candidates.append(_candidate(timestamp, frame))

    # Probe only a bounded number of midpoints where consecutive coarse frames
    # changed the most. This catches transitions without changing the O(D/I)
    # coarse sampling budget.
    transitions: list[tuple[float, float]] = []
    for previous, current_candidate in zip(candidates, candidates[1:]):
        change = _mean_difference(previous["thumbnail"], current_candidate["thumbnail"])
        midpoint = (float(previous["timestamp"]) + float(current_candidate["timestamp"])) / 2.0
        transitions.append((change, midpoint))
    for change, timestamp in sorted(transitions, reverse=True)[:MAX_REFINEMENT_PROBES]:
        if change < 0.12:
            break
        frame = _extract_gray_frame(ffmpeg, media_path, timestamp)
        if frame is not None:
            candidates.append(_candidate(timestamp, frame))

    slide_hashes = []
    for slide_path in slide_image_paths or []:
        thumbnail = _extract_gray_image(ffmpeg, slide_path)
        if thumbnail is not None:
            slide_hashes.append(_difference_hash(thumbnail))

    selected = _rank_candidates(candidates, slide_hashes, duration, max_frames)
    selected_dir = artifact_dir / "selected"
    selected_dir.mkdir(parents=True, exist_ok=True)
    safe_id = re.sub(r"[^a-zA-Z0-9_-]+", "-", lecture_id).strip("-") or "lecture"
    frames: list[dict[str, object]] = []
    for candidate in selected:
        timestamp = float(candidate["timestamp"])
        timestamp_label = _format_timestamp_filename(timestamp)
        name = f"{safe_id}-video-{timestamp_label}.jpg"
        output_path = selected_dir / name
        if not output_path.is_file() and not _extract_full_frame(
            ffmpeg, media_path, timestamp, output_path
        ):
            continue
        frames.append(
            {
                "name": name,
                "path": str(output_path.resolve()),
                "kind": "video",
                "source_key": f"video::{timestamp:.3f}",
                "caption": f"Recording frame at {_format_timestamp(timestamp)}",
                "timestamp": timestamp,
                "transcript_excerpt": _nearby_transcript(transcript, timestamp),
                "score": round(float(candidate["score"]), 6),
            }
        )

    payload = {"cache_key": cache_key, "frames": frames}
    manifest_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    LOGGER.info("Selected %d video frames for lecture %s", len(frames), lecture_id)
    return frames


def _resolve_binary(name: str, env_key: str) -> Path | None:
    configured = os.getenv(env_key, "").strip()
    if configured:
        path = Path(configured).expanduser().resolve()
        if path.is_file() and os.access(path, os.X_OK):
            return path
    resolved = shutil.which(name)
    return Path(resolved).resolve() if resolved else None


def _probe_duration(media_path: Path) -> float:
    ffprobe = _resolve_binary("ffprobe", "FFPROBE_BIN")
    if ffprobe is None:
        return 0.0
    result = subprocess.run(
        [
            str(ffprobe),
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(media_path),
        ],
        capture_output=True,
        text=True,
        check=False,
        timeout=30,
    )
    try:
        return float(result.stdout.strip()) if result.returncode == 0 else 0.0
    except ValueError:
        return 0.0


def _transcript_duration(transcript: TranscriptResult) -> float:
    return max((segment.end for segment in transcript.segments), default=0.0)


def _cache_key(
    media_path: Path,
    interval_seconds: int,
    max_frames: int,
    duration: float,
    transcript: TranscriptResult,
    slide_image_paths: list[Path],
) -> dict[str, object]:
    stat = media_path.stat()
    return {
        "selector_version": SELECTOR_VERSION,
        "media_path": str(media_path),
        "media_size": stat.st_size,
        "media_mtime_ns": stat.st_mtime_ns,
        "interval_seconds": interval_seconds,
        "max_frames": max_frames,
        "duration_seconds": round(duration, 3),
        "transcript_hash": hashlib.sha1(transcript.full_text.encode("utf-8")).hexdigest()[:16],
        "slide_assets": sorted(path.name for path in slide_image_paths),
    }


def _load_cached_frames(
    manifest_path: Path, cache_key: dict[str, object]
) -> list[dict[str, object]] | None:
    if not manifest_path.is_file():
        return None
    try:
        payload = json.loads(manifest_path.read_text(encoding="utf-8"))
        frames = payload.get("frames", [])
        if payload.get("cache_key") != cache_key or not isinstance(frames, list):
            return None
        if not all(Path(str(frame.get("path", ""))).is_file() for frame in frames):
            return None
        return frames
    except (OSError, ValueError, TypeError):
        return None


def _extract_gray_frame(ffmpeg: Path, media_path: Path, timestamp: float) -> np.ndarray | None:
    command = [
        str(ffmpeg),
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{timestamp:.3f}",
        "-i",
        str(media_path),
        "-frames:v",
        "1",
        "-threads",
        "1",
        "-vf",
        (
            f"scale={THUMBNAIL_WIDTH}:{THUMBNAIL_HEIGHT}:force_original_aspect_ratio=decrease,"
            f"pad={THUMBNAIL_WIDTH}:{THUMBNAIL_HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=gray"
        ),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "pipe:1",
    ]
    return _run_gray_command(command)


def _extract_gray_image(ffmpeg: Path, image_path: Path) -> np.ndarray | None:
    command = [
        str(ffmpeg),
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(image_path),
        "-frames:v",
        "1",
        "-threads",
        "1",
        "-vf",
        (
            f"scale={THUMBNAIL_WIDTH}:{THUMBNAIL_HEIGHT}:force_original_aspect_ratio=decrease,"
            f"pad={THUMBNAIL_WIDTH}:{THUMBNAIL_HEIGHT}:(ow-iw)/2:(oh-ih)/2,format=gray"
        ),
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "pipe:1",
    ]
    return _run_gray_command(command)


def _run_gray_command(command: list[str]) -> np.ndarray | None:
    try:
        result = subprocess.run(
            command,
            capture_output=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    expected = THUMBNAIL_WIDTH * THUMBNAIL_HEIGHT
    if result.returncode != 0 or len(result.stdout) < expected:
        return None
    return np.frombuffer(result.stdout[:expected], dtype=np.uint8).reshape(
        THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH
    )


def _extract_full_frame(
    ffmpeg: Path, media_path: Path, timestamp: float, output_path: Path
) -> bool:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            str(ffmpeg),
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            f"{timestamp:.3f}",
            "-i",
            str(media_path),
            "-frames:v",
            "1",
            "-threads",
            "1",
            "-vf",
            "scale=min(1600\\,iw):-2",
            "-q:v",
            "2",
            "-y",
            str(output_path),
        ],
        capture_output=True,
        check=False,
        timeout=60,
    )
    return result.returncode == 0 and output_path.is_file() and output_path.stat().st_size > 0


def _candidate(timestamp: float, thumbnail: np.ndarray) -> dict[str, object]:
    pixels = thumbnail.astype(np.float32)
    horizontal = np.abs(np.diff(pixels, axis=1))
    vertical = np.abs(np.diff(pixels, axis=0))
    sharpness = float((horizontal.mean() + vertical.mean()) / (2.0 * 255.0))
    edge_density = float(
        (np.mean(horizontal > 18.0) + np.mean(vertical > 18.0)) / 2.0
    )
    return {
        "timestamp": timestamp,
        "thumbnail": thumbnail,
        "hash": _difference_hash(thumbnail),
        "sharpness": sharpness,
        "edge_density": edge_density,
        "contrast": float(pixels.std() / 255.0),
        "exposure": float(1.0 - abs(float(pixels.mean()) - 127.5) / 127.5),
    }


def _rank_candidates(
    candidates: list[dict[str, object]],
    slide_hashes: list[int],
    duration: float,
    max_frames: int,
) -> list[dict[str, object]]:
    if not candidates:
        return []
    candidates.sort(key=lambda item: float(item["timestamp"]))
    for key in ("sharpness", "edge_density", "contrast", "exposure"):
        values = [float(item[key]) for item in candidates]
        low, high = min(values), max(values)
        span = high - low
        for item in candidates:
            item[f"normalized_{key}"] = (float(item[key]) - low) / span if span > 1e-9 else 0.5

    eligible = [
        item
        for item in candidates
        if float(item["contrast"]) >= 0.02 and float(item["sharpness"]) >= 0.002
    ]
    for item in eligible:
        frame_hash = int(item["hash"])
        slide_novelty = (
            min(_hamming_distance(frame_hash, slide_hash) for slide_hash in slide_hashes) / 64.0
            if slide_hashes
            else 1.0
        )
        temporal_position = float(item["timestamp"]) / max(duration, 1.0)
        item["score"] = (
            0.28 * float(item["normalized_sharpness"])
            + 0.24 * float(item["normalized_edge_density"])
            + 0.20 * float(item["normalized_contrast"])
            + 0.08 * float(item["normalized_exposure"])
            + 0.17 * slide_novelty
            + 0.03 * temporal_position
        )

    selected: list[dict[str, object]] = []
    for item in sorted(eligible, key=lambda candidate: float(candidate["score"]), reverse=True):
        timestamp = float(item["timestamp"])
        frame_hash = int(item["hash"])
        if slide_hashes and min(
            _hamming_distance(frame_hash, slide_hash) for slide_hash in slide_hashes
        ) <= 3:
            continue
        if any(
            abs(timestamp - float(existing["timestamp"])) < MIN_SELECTED_SPACING_SECONDS
            or _hamming_distance(frame_hash, int(existing["hash"])) <= 6
            for existing in selected
        ):
            continue
        selected.append(item)
        if len(selected) >= max_frames:
            break
    return sorted(selected, key=lambda item: float(item["timestamp"]))


def _difference_hash(thumbnail: np.ndarray) -> int:
    y_indices = np.linspace(0, thumbnail.shape[0] - 1, 8, dtype=int)
    x_indices = np.linspace(0, thumbnail.shape[1] - 1, 9, dtype=int)
    sampled = thumbnail[np.ix_(y_indices, x_indices)]
    bits = sampled[:, 1:] > sampled[:, :-1]
    value = 0
    for bit in bits.flat:
        value = (value << 1) | int(bit)
    return value


def _hamming_distance(left: int, right: int) -> int:
    return (left ^ right).bit_count()


def _mean_difference(left: object, right: object) -> float:
    left_array = np.asarray(left, dtype=np.int16)
    right_array = np.asarray(right, dtype=np.int16)
    return float(np.abs(left_array - right_array).mean() / 255.0)


def _nearby_transcript(transcript: TranscriptResult, timestamp: float) -> str:
    text = " ".join(
        segment.text.strip()
        for segment in transcript.segments
        if segment.text.strip() and segment.end >= timestamp - 60 and segment.start <= timestamp + 60
    )
    return text[:900]


def _format_timestamp(seconds: float) -> str:
    total = max(0, int(round(seconds)))
    hours, remainder = divmod(total, 3600)
    minutes, secs = divmod(remainder, 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def _format_timestamp_filename(seconds: float) -> str:
    return _format_timestamp(seconds).replace(":", "h", 1).replace(":", "m", 1) + "s"
