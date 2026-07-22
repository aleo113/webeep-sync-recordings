from __future__ import annotations

import unittest
import tempfile
import threading
from pathlib import Path
from unittest.mock import patch

from src.config import AppConfig
from src.models import TranscriptResult, TranscriptSegment
from src.pipeline import _note_filename, run_pipeline


class NoteFilenameTests(unittest.TestCase):
    def test_uses_readable_recording_name_and_removes_webex_suffix(self) -> None:
        used: set[str] = set()
        result = _note_filename(
            Path("Lesson 2026_05_25 - Danilo Ardagna's Personal Room-20260525 1402-1.mp4"),
            "f516f48bc4e8402cae74f44616d45fb4",
            used,
        )
        self.assertEqual(result, "Lesson 2026_05_25 - Danilo Ardagna.md")

    def test_collision_gets_a_stable_suffix(self) -> None:
        used: set[str] = set()
        media = Path("Lesson 2026_05_25-20260525 1402-1.mp4")
        self.assertEqual(_note_filename(media, "one", used), "Lesson 2026_05_25.md")
        self.assertEqual(_note_filename(media, "two", used), "Lesson 2026_05_25 (2).md")

    def test_prefetches_only_next_download_while_processing_current(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            second_download_started = threading.Event()
            allow_second_download = threading.Event()
            first_transcription_saw_prefetch = []

            def download(url, output_dir, *_args, **_kwargs):
                output_dir.mkdir(parents=True, exist_ok=True)
                media = output_dir / f"{url.rsplit('/', 1)[-1]}.mp4"
                if url.endswith("two"):
                    second_download_started.set()
                    allow_second_download.wait(timeout=2)
                media.write_bytes(b"media")
                return media

            transcription_count = 0

            def transcribe(**_kwargs):
                nonlocal transcription_count
                transcription_count += 1
                if transcription_count == 1:
                    first_transcription_saw_prefetch.append(
                        second_download_started.wait(timeout=2)
                    )
                    allow_second_download.set()
                return TranscriptResult(
                    language="en",
                    full_text="lecture",
                    segments=[TranscriptSegment(0, 1, "lecture")],
                )

            config = AppConfig(
                poliwebex_path=root / "PoliWebex",
                whisper_model="small",
                whisper_language=None,
                whisper_num_cores=1,
                top_k_matches=0,
                notes_mode="transcript-only",
                codex_bin="codex",
                codex_model="gpt-5.6-luna",
                codex_reasoning_effort="high",
                codex_timeout_seconds=60,
                max_slide_images=0,
                prefetch_downloads=True,
            )

            with (
                patch("src.pipeline.INTERMEDIATE_ROOT", root / "artifacts"),
                patch("src.pipeline.PoliWebexRunner") as runner_type,
                patch("src.pipeline.find_pdf_files", return_value=[]),
                patch("src.pipeline.build_pdf_page_contexts", return_value=[]),
                patch("src.pipeline.rank_pdf_pages", return_value=[]),
                patch("src.pipeline.transcribe_media", side_effect=transcribe),
            ):
                runner_type.return_value.download_single.side_effect = download
                results = run_pipeline(
                    ["https://example.test/one", "https://example.test/two"],
                    root / "materials",
                    root / "notes",
                    config,
                    retry_interval=1,
                    skip_keyring=True,
                )

            self.assertEqual(len(results), 2)
            self.assertEqual(first_transcription_saw_prefetch, [True])
            self.assertEqual(runner_type.return_value.download_single.call_count, 2)

    def test_foreground_failure_cancels_prefetch_and_never_starts_third_download(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            second_started = threading.Event()
            second_cancelled = threading.Event()

            def download(url, output_dir, _retry, _skip_keyring, cancel_event):
                output_dir.mkdir(parents=True, exist_ok=True)
                if url.endswith("two"):
                    second_started.set()
                    if cancel_event.wait(timeout=2):
                        second_cancelled.set()
                        raise RuntimeError("cancelled")
                media = output_dir / "lecture.mp4"
                media.write_bytes(b"media")
                return media

            def fail_transcription(**_kwargs):
                self.assertTrue(second_started.wait(timeout=2))
                raise RuntimeError("transcription failed")

            config = AppConfig(
                poliwebex_path=root / "PoliWebex",
                whisper_model="small",
                whisper_language=None,
                whisper_num_cores=1,
                top_k_matches=0,
                notes_mode="transcript-only",
                codex_bin="codex",
                codex_model="gpt-5.6-luna",
                codex_reasoning_effort="high",
                codex_timeout_seconds=60,
                max_slide_images=0,
                prefetch_downloads=True,
            )

            with (
                patch("src.pipeline.INTERMEDIATE_ROOT", root / "artifacts"),
                patch("src.pipeline.PoliWebexRunner") as runner_type,
                patch("src.pipeline.find_pdf_files", return_value=[]),
                patch("src.pipeline.build_pdf_page_contexts", return_value=[]),
                patch("src.pipeline.transcribe_media", side_effect=fail_transcription),
            ):
                runner_type.return_value.download_single.side_effect = download
                with self.assertRaisesRegex(RuntimeError, "transcription failed"):
                    run_pipeline(
                        [
                            "https://example.test/one",
                            "https://example.test/two",
                            "https://example.test/three",
                        ],
                        root / "materials",
                        root / "notes",
                        config,
                        retry_interval=1,
                        skip_keyring=True,
                    )

            self.assertTrue(second_cancelled.is_set())
            self.assertEqual(runner_type.return_value.download_single.call_count, 2)


if __name__ == "__main__":
    unittest.main()
