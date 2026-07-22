from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.models import PdfChunk, PdfPageContext, RetrievalMatch, TranscriptResult, TranscriptSegment
from src.notes_generator import (
    _append_course_material_references,
    _allocate_visual_budget,
    _build_notes_prompt,
    _ensure_slide_images,
    _run_codex,
    _validate_and_copy_visual_assets,
    normalize_obsidian_math,
)


class NotesGeneratorTests(unittest.TestCase):
    def test_normalizes_math_outside_code_fences(self) -> None:
        source = "Inline \\(x+y\\).\n\\[\nx^2\n\\]\n```\n\\(leave me\\)\n```"
        result = normalize_obsidian_math(source)
        self.assertIn("Inline $x+y$.", result)
        self.assertIn("$$\nx^2\n$$", result)
        self.assertIn("```\n\\(leave me\\)\n```", result)

    @patch("src.notes_generator.shutil.which", return_value="/usr/bin/codex")
    @patch("src.notes_generator.subprocess.run")
    def test_codex_uses_chatgpt_cli_model_and_high_reasoning(self, run, _which) -> None:
        run.return_value = subprocess.CompletedProcess([], 0, "# Notes", "")
        result = _run_codex(
            prompt="lecture context",
            codex_bin="codex",
            model="gpt-5.6-luna",
            reasoning_effort="high",
            timeout_seconds=60,
            image_paths=[Path("/tmp/slide.png")],
        )
        self.assertEqual(result, "# Notes")
        command = run.call_args.args[0]
        self.assertIn("gpt-5.6-luna", command)
        self.assertIn('model_reasoning_effort="high"', command)
        self.assertEqual(run.call_args.kwargs["input"], "lecture context")
        self.assertIn("--ephemeral", command)
        self.assertIn("read-only", command)
        self.assertIn("shell_tool", command)
        self.assertIn('web_search="disabled"', command)
        self.assertIn("--image", command)
        self.assertIn("/tmp/slide.png", command)

    def test_at_least_one_slide_is_embedded_without_creating_a_gallery(self) -> None:
        result = _ensure_slide_images(
            "# Topic\n\nText.\n\n## Exam-focused recap\n\nReview.",
            [{"name": "slide-p1.png", "caption": "Slides, page 1", "source_key": "s::1"}],
        )
        self.assertIn("![[assets/slide-p1.png]]", result)
        self.assertIn("### Key lecture slide", result)
        self.assertNotIn("Additional slide images", result)
        self.assertLess(result.index("slide-p1.png"), result.index("## Exam-focused recap"))

    def test_prompt_separates_evidence_and_maps_attached_slide(self) -> None:
        source = Path("/tmp/Lecture Slides.pdf")
        page = PdfPageContext(
            source_path=source,
            page_number=4,
            text_layer="Throughput X equals C times U.",
            ocr_text="",
            combined_text="Throughput X equals C times U.",
            width=1280,
            height=720,
        )
        match = RetrievalMatch(
            chunk=PdfChunk(source, 4, 0, page.combined_text),
            score=0.75,
        )
        transcript = TranscriptResult(
            language="en",
            full_text="Today we derive the utilization law.",
            segments=[
                TranscriptSegment(0, 65, "Today we derive the utilization law."),
                TranscriptSegment(65, 130, "Throughput equals capacity times utilization."),
            ],
        )
        prompt = _build_notes_prompt(
            lecture_id="lecture-1",
            source_url="https://example.test/recording",
            transcript=transcript,
            page_contexts=[page],
            matches=[match],
            rendered_images=[
                {
                    "name": "lecture-1-p4.png",
                    "path": "/tmp/lecture-1-p4.png",
                    "caption": "Lecture Slides.pdf, page 4",
                    "source_key": f"{source.resolve()}::4",
                }
            ],
        )
        self.assertIn("transcript as the primary evidence", prompt)
        self.assertIn("can be false positives", prompt)
        self.assertIn("lecture-1-p4.png -> MATERIAL-1", prompt)
        self.assertIn("[00:00:00–00:02:10]", prompt)
        self.assertIn("<course_material>", prompt)
        self.assertIn("<chronological_transcript>", prompt)

    def test_reference_list_keeps_only_cited_or_embedded_pages(self) -> None:
        cited_source = Path("/tmp/Cited Slides.pdf")
        unused_source = Path("/tmp/Unrelated Book.pdf")
        matches = [
            RetrievalMatch(PdfChunk(cited_source, 2, 0, "supported"), 0.8),
            RetrievalMatch(PdfChunk(unused_source, 9, 0, "unused"), 0.4),
        ]
        cited_key = f"{cited_source.resolve()}::2"
        notes = "# Topic\n\n![[assets/cited-p2.png]]"
        result = _append_course_material_references(
            notes,
            matches,
            [
                {
                    "name": "cited-p2.png",
                    "path": "/tmp/cited-p2.png",
                    "caption": "Cited Slides.pdf, page 2",
                    "source_key": cited_key,
                }
            ],
        )
        self.assertIn("Cited Slides.pdf", result)
        self.assertNotIn("Unrelated Book.pdf", result)

    def test_prompt_maps_video_frame_to_timestamp_and_transcript(self) -> None:
        transcript = TranscriptResult(
            language="en",
            full_text="The professor completes the derivation.",
            segments=[TranscriptSegment(120, 180, "The professor completes the derivation.")],
        )
        prompt = _build_notes_prompt(
            lecture_id="lecture",
            source_url="https://example.test/lecture",
            transcript=transcript,
            page_contexts=[],
            matches=[],
            rendered_images=[],
            video_frames=[
                {
                    "name": "lecture-video-00h02m30s.jpg",
                    "path": "/tmp/frame.jpg",
                    "caption": "Recording frame at 00:02:30",
                    "timestamp": 150,
                    "transcript_excerpt": "The professor completes the derivation.",
                }
            ],
        )
        self.assertIn("lecture-video-00h02m30s.jpg -> FRAME-1", prompt)
        self.assertIn("Timestamp: 00:02:30", prompt)
        self.assertIn("The professor completes the derivation.", prompt)

    def test_combined_visual_budget_reserves_video_slots(self) -> None:
        slides = [{"name": f"slide-{index}.png"} for index in range(8)]
        frames = [
            {"name": f"frame-{index}.jpg", "score": 1.0 - index / 10, "timestamp": index * 60}
            for index in range(8)
        ]
        selected_slides, selected_frames = _allocate_visual_budget(slides, frames, 12)
        self.assertEqual(len(selected_slides), 7)
        self.assertEqual(len(selected_frames), 5)
        self.assertEqual(len(selected_slides) + len(selected_frames), 12)

    def test_visual_assets_copies_only_valid_referenced_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "working.jpg"
            source.write_bytes(b"image")
            notes, embedded = _validate_and_copy_visual_assets(
                "![[assets/frame.jpg]]\n![[assets/invented.jpg]]",
                [{"name": "frame.jpg", "path": str(source)}],
                root / "assets",
            )
            self.assertIn("![[assets/frame.jpg]]", notes)
            self.assertNotIn("invented.jpg", notes)
            self.assertEqual(embedded, {"frame.jpg"})
            self.assertTrue((root / "assets" / "frame.jpg").is_file())


if __name__ == "__main__":
    unittest.main()
