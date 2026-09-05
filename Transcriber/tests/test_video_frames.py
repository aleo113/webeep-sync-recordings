from __future__ import annotations

import unittest
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

from src.video_frames import (
    THUMBNAIL_HEIGHT,
    THUMBNAIL_WIDTH,
    _candidate,
    _rank_candidates,
    select_video_frames,
)
from src.models import TranscriptResult, TranscriptSegment


class VideoFrameSelectionTests(unittest.TestCase):
    def test_rejects_empty_frames_and_keeps_temporally_spaced_content(self) -> None:
        empty = np.full((THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH), 127, dtype=np.uint8)
        checker = np.indices((THUMBNAIL_HEIGHT, THUMBNAIL_WIDTH)).sum(axis=0) % 2 * 255
        stripes = np.tile(
            ((np.arange(THUMBNAIL_WIDTH) // 8) % 2 * 255).astype(np.uint8),
            (THUMBNAIL_HEIGHT, 1),
        )
        candidates = [
            _candidate(30, empty),
            _candidate(90, checker.astype(np.uint8)),
            _candidate(150, checker.astype(np.uint8)),
            _candidate(270, stripes),
        ]

        selected = _rank_candidates(candidates, [], duration=300, max_frames=8)

        timestamps = [float(item["timestamp"]) for item in selected]
        self.assertNotIn(30.0, timestamps)
        self.assertLessEqual(len(timestamps), 2)
        if len(timestamps) == 2:
            self.assertGreaterEqual(timestamps[1] - timestamps[0], 120)

    @unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg is required")
    def test_selects_and_caches_frames_from_synthetic_video(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            media = root / "lecture.mp4"
            subprocess.run(
                [
                    shutil.which("ffmpeg") or "ffmpeg",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-f",
                    "lavfi",
                    "-i",
                    "testsrc2=duration=125:size=320x180:rate=1",
                    "-c:v",
                    "mpeg4",
                    "-y",
                    str(media),
                ],
                check=True,
            )
            transcript = TranscriptResult(
                "en",
                "A changing visual demonstration.",
                [TranscriptSegment(0, 125, "A changing visual demonstration.")],
            )
            first = select_video_frames(media, transcript, root / "frames", "lecture")
            second = select_video_frames(media, transcript, root / "frames", "lecture")
            self.assertEqual(first, second)
            self.assertTrue((root / "frames" / "manifest.json").is_file())
            self.assertTrue(first)
            self.assertTrue(all(Path(str(frame["path"])).is_file() for frame in first))


if __name__ == "__main__":
    unittest.main()
