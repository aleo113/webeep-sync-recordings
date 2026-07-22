from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass
class TranscriptSegment:
    start: float
    end: float
    text: str
    avg_logprob: float | None = None
    no_speech_prob: float | None = None
    compression_ratio: float | None = None


@dataclass
class TranscriptResult:
    language: str
    full_text: str
    segments: list[TranscriptSegment]


@dataclass
class PdfChunk:
    source_path: Path
    page_number: int
    chunk_index: int
    text: str


@dataclass
class PdfPageContext:
    source_path: Path
    page_number: int
    text_layer: str
    ocr_text: str
    combined_text: str
    width: float = 0.0
    height: float = 0.0


@dataclass
class RetrievalMatch:
    chunk: PdfChunk
    score: float


@dataclass
class LectureArtifacts:
    lecture_id: str
    source_url: str
    media_file: Path
    transcript_txt: Path
    transcript_json: Path
    prompt_markdown: Path | None
    notes_markdown: Path | None
    metadata_json: Path
