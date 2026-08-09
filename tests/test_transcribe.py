from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from src.models import PdfPageContext, TranscriptSegment
from src.transcribe import (
    _get_model,
    _mean_quality,
    _uncertain_windows,
    build_course_hotwords,
    clear_model_cache,
    transcribe_media,
)


class TranscriptionTests(unittest.TestCase):
    def tearDown(self) -> None:
        clear_model_cache()

    def test_builds_bounded_course_glossary_from_files_and_terms(self) -> None:
        pages = [
            PdfPageContext(
                Path("/course/Proximal_Mapping.pdf"),
                1,
                "",
                "",
                "ISTA uses a Proximal Mapping. ISTA converges under Lipschitz Continuity.",
            )
        ]
        hotwords = build_course_hotwords(pages, max_characters=100)
        self.assertIn("Proximal Mapping", hotwords)
        self.assertIn("ISTA", hotwords)
        self.assertLessEqual(len(hotwords), 100)

    def test_model_cache_reuses_same_model_and_cpu_thread_setting(self) -> None:
        with patch("faster_whisper.WhisperModel") as model_type:
            model_type.return_value = object()
            first = _get_model("small", 4)
            second = _get_model("small", 4)
        self.assertIs(first, second)
        model_type.assert_called_once_with(
            "small",
            device="cpu",
            compute_type="int8",
            cpu_threads=4,
        )

    def test_fast_profile_uses_vad_hotwords_and_retains_confidence(self) -> None:
        source_segment = SimpleNamespace(
            start=1.0,
            end=3.0,
            text="Proximal mapping",
            avg_logprob=-0.2,
            no_speech_prob=0.05,
            compression_ratio=1.1,
        )
        model = Mock()
        model.transcribe.return_value = (
            [source_segment],
            SimpleNamespace(duration=10.0, language="en"),
        )
        with tempfile.TemporaryDirectory() as directory, patch(
            "src.transcribe._get_model", return_value=model
        ):
            media = Path(directory) / "lecture.mp4"
            media.write_bytes(b"media")
            result = transcribe_media(
                media,
                "small",
                hotwords="ISTA, Proximal Mapping",
                profile="fast",
                vad_filter=True,
            )
        kwargs = model.transcribe.call_args.kwargs
        self.assertTrue(kwargs["vad_filter"])
        self.assertEqual(kwargs["initial_prompt"], "ISTA, Proximal Mapping")
        self.assertNotIn("hotwords", kwargs)
        self.assertEqual(kwargs["language_detection_segments"], 3)
        self.assertEqual(result.segments[0].avg_logprob, -0.2)

    def test_hotwords_use_the_bounded_initial_prompt_path(self) -> None:
        model = Mock()
        model.transcribe.return_value = (
            [],
            SimpleNamespace(duration=10.0, language="en"),
        )
        with tempfile.TemporaryDirectory() as directory, patch(
            "src.transcribe._get_model", return_value=model
        ):
            media = Path(directory) / "lecture.mp4"
            media.write_bytes(b"media")
            transcribe_media(media, "small", hotwords="A" * 1200, profile="fast")
        kwargs = model.transcribe.call_args.kwargs
        self.assertEqual(kwargs["initial_prompt"], "A" * 1200)
        self.assertNotIn("hotwords", kwargs)

    def test_balanced_profile_replaces_only_uncertain_regions(self) -> None:
        primary = Mock()
        primary.transcribe.return_value = (
            [
                SimpleNamespace(
                    start=10.0,
                    end=15.0,
                    text="incorrect technical term",
                    avg_logprob=-1.2,
                    no_speech_prob=0.1,
                    compression_ratio=1.0,
                )
            ],
            SimpleNamespace(duration=100.0, language="en"),
        )
        retry = Mock()
        corrected = [TranscriptSegment(8.0, 17.0, "correct technical term", -0.1, 0.0, 1.0)]
        with tempfile.TemporaryDirectory() as directory, patch(
            "src.transcribe._get_model", side_effect=[primary, retry]
        ), patch(
            "src.transcribe._retry_windows", return_value=corrected
        ) as retry_windows:
            media = Path(directory) / "lecture.mp4"
            media.write_bytes(b"media")
            result = transcribe_media(media, "small", profile="balanced")
        retry_windows.assert_called_once()
        self.assertEqual(result.full_text, "correct technical term")

    def test_uncertain_retry_budget_is_bounded(self) -> None:
        segments = [
            TranscriptSegment(index * 100, index * 100 + 80, "uncertain", -2.0, 0.0, 1.0)
            for index in range(20)
        ]
        windows = _uncertain_windows(segments, duration=4000, max_retry_fraction=0.5)
        retried_seconds = sum(end - start for start, end, _score in windows)
        self.assertLessEqual(retried_seconds, 900)

    def test_retry_quality_prefers_more_confident_nonrepetitive_text(self) -> None:
        weak = [TranscriptSegment(0, 5, "wrong", -1.1, 0.7, 2.5)]
        strong = [TranscriptSegment(0, 5, "correct", -0.3, 0.1, 1.1)]
        self.assertGreater(_mean_quality(strong), _mean_quality(weak))


if __name__ == "__main__":
    unittest.main()
