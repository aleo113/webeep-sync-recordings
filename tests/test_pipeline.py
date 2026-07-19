from __future__ import annotations

import unittest
from pathlib import Path

from src.pipeline import _note_filename


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


if __name__ == "__main__":
    unittest.main()
