from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.api import (
    ProcessOptions,
    TranscriberError,
    download_recording,
    process_media,
)
from src.models import TranscriptResult, TranscriptSegment


class LocalMediaApiTests(unittest.TestCase):
    def test_download_delegates_to_poliwebex_runner(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            expected = root / "lecture.mp4"
            with patch("src.api.PoliWebexRunner") as runner_type:
                runner_type.return_value.download_single.return_value = expected
                result = download_recording(
                    "https://example.test/recording",
                    root,
                    root / "PoliWebex",
                )
            self.assertEqual(result, expected)
            runner_type.return_value.validate_environment.assert_called_once()

    def test_processes_existing_media_without_downloader(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "lecture.mp4"
            media.write_bytes(b"test media")
            events = []
            transcript = TranscriptResult(
                language="en",
                full_text="A useful lecture transcript.",
                segments=[TranscriptSegment(0.0, 1.0, "A useful lecture transcript.")],
            )

            with patch("src.api.transcribe_media", return_value=transcript):
                artifacts = process_media(
                    media,
                    ProcessOptions(
                        workspace_root=root / "workspace",
                        output_root=root / "notes",
                        lecture_id="lecture-id",
                    ),
                    on_progress=events.append,
                )

            self.assertEqual(artifacts.lecture_id, "lecture-id")
            self.assertEqual(
                artifacts.transcript_txt.read_text(encoding="utf-8"),
                transcript.full_text,
            )
            self.assertTrue(artifacts.metadata_json.is_file())
            self.assertEqual(events[-1].stage, "complete")

    def test_missing_media_has_stable_error_code(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(TranscriberError) as raised:
                process_media(
                    Path(directory) / "missing.mp4",
                    ProcessOptions(
                        workspace_root=Path(directory) / "workspace",
                        output_root=Path(directory) / "notes",
                    ),
                )
            self.assertEqual(raised.exception.code, "MEDIA_NOT_FOUND")


if __name__ == "__main__":
    unittest.main()
