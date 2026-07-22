from __future__ import annotations

import json
from pathlib import Path

from .models import LectureArtifacts, PdfPageContext, RetrievalMatch, TranscriptResult, TranscriptSegment


def load_transcript_files(txt_path: Path, json_path: Path) -> TranscriptResult | None:
    if not txt_path.is_file() or not json_path.is_file():
        return None

    payload = json.loads(json_path.read_text(encoding="utf-8"))
    segments = [
        {
            "start": segment.get("start", 0.0),
            "end": segment.get("end", 0.0),
            "text": segment.get("text", ""),
            "avg_logprob": segment.get("avg_logprob"),
            "no_speech_prob": segment.get("no_speech_prob"),
            "compression_ratio": segment.get("compression_ratio"),
        }
        for segment in payload.get("segments", [])
        if segment.get("text", "").strip()
    ]

    return TranscriptResult(
        language=payload.get("language", "unknown"),
        full_text=txt_path.read_text(encoding="utf-8"),
        segments=[
            TranscriptSegment(
                start=float(segment["start"]),
                end=float(segment["end"]),
                text=str(segment["text"]),
                avg_logprob=(
                    float(segment["avg_logprob"])
                    if segment.get("avg_logprob") is not None
                    else None
                ),
                no_speech_prob=(
                    float(segment["no_speech_prob"])
                    if segment.get("no_speech_prob") is not None
                    else None
                ),
                compression_ratio=(
                    float(segment["compression_ratio"])
                    if segment.get("compression_ratio") is not None
                    else None
                ),
            )
            for segment in segments
        ],
    )


def write_transcript_files(transcript: TranscriptResult, out_dir: Path) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    txt_path = out_dir / "transcript.txt"
    json_path = out_dir / "transcript.json"

    txt_path.write_text(transcript.full_text, encoding="utf-8")

    payload = {
        "language": transcript.language,
        "segments": [
            {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text,
                "avg_logprob": segment.avg_logprob,
                "no_speech_prob": segment.no_speech_prob,
                "compression_ratio": segment.compression_ratio,
            }
            for segment in transcript.segments
        ],
    }
    json_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return txt_path, json_path


def write_prompt_pack(
    lecture_id: str,
    source_url: str,
    transcript: TranscriptResult,
    page_contexts: list[PdfPageContext],
    prompt_path: Path,
) -> None:
    prompt_path.parent.mkdir(parents=True, exist_ok=True)

    page_lines: list[str] = []
    for idx, page in enumerate(page_contexts, start=1):
        page_lines.append(
            f"### Source {idx}\n"
            f"- File: {page.source_path.name}\n"
            f"- Page: {page.page_number}\n"
            f"- Text layer:\n{page.text_layer or '[empty]'}\n"
            f"- OCR text:\n{page.ocr_text or '[empty]'}\n"
        )

    content = f"""# Lecture Prompt Pack - {lecture_id}

## Context
- Lecture URL: {source_url}
- Detected transcript language: {transcript.language}

## Task for LLM
You are generating structured lecture notes from transcript + course material excerpts.

Requirements:
1. Produce clear sectioned notes with headings and key concepts in a markdown file.
2. Explain definitions and methods in simple language.
3. Add a short summary and a list of likely exam-relevant points.
4. Use the supplied PDF pages as atomic units and decide which page belongs under each topic.
5. Cite source file and page number wherever a claim comes from a PDF page.
6. If information is uncertain or missing, explicitly mark assumptions.

## Transcript
{transcript.full_text}

## Retrieved course material pages
{chr(10).join(page_lines)}
"""

    prompt_path.write_text(content, encoding="utf-8")


def write_metadata(
    artifacts: LectureArtifacts,
    matches: list[RetrievalMatch],
    metadata_path: Path,
    notes_model: str | None = None,
    notes_reasoning_effort: str | None = None,
    visual_context_path: Path | None = None,
    transcription_settings: dict[str, object] | None = None,
) -> None:
    metadata_path.parent.mkdir(parents=True, exist_ok=True)

    visual_context = None
    if visual_context_path is not None and visual_context_path.is_file():
        try:
            visual_context = json.loads(visual_context_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            visual_context = None

    payload = {
        "lecture_id": artifacts.lecture_id,
        "source_url": artifacts.source_url,
        "media_file": str(artifacts.media_file),
        "transcript_txt": str(artifacts.transcript_txt),
        "transcript_json": str(artifacts.transcript_json),
        "prompt_markdown": str(artifacts.prompt_markdown) if artifacts.prompt_markdown else None,
        "notes_markdown": str(artifacts.notes_markdown) if artifacts.notes_markdown else None,
        "notes_generator": (
            {
                "provider": "codex-cli",
                "model": notes_model,
                "reasoning_effort": notes_reasoning_effort,
            }
            if notes_model
            else None
        ),
        "transcription": transcription_settings,
        "visual_context": visual_context,
        "retrieval_matches": [
            {
                "rank": i,
                "score": m.score,
                "source_file": str(m.chunk.source_path),
                "source_file_name": m.chunk.source_path.name,
                "source_file_relative": str(m.chunk.source_path.parent.name + "/" + m.chunk.source_path.name),
                "page_number": m.chunk.page_number,
                "chunk_index": m.chunk.chunk_index,
            }
            for i, m in enumerate(matches, start=1)
        ],
    }

    metadata_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
