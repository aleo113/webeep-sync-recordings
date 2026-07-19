from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from src.cli import collect_urls, load_urls_file


class UrlInputTests(unittest.TestCase):
    def test_load_urls_file_ignores_comments_and_blank_lines(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recordings.txt"
            path.write_text(
                "# course recordings\n\nhttps://example.test/one\n  https://example.test/two  \n",
                encoding="utf-8",
            )
            self.assertEqual(
                load_urls_file(str(path)),
                ["https://example.test/one", "https://example.test/two"],
            )

    def test_collect_urls_merges_and_deduplicates(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recordings.txt"
            path.write_text(
                "https://example.test/two\nhttps://example.test/three\n",
                encoding="utf-8",
            )
            args = SimpleNamespace(
                urls=["https://example.test/one", "https://example.test/two"],
                urls_file=str(path),
            )
            self.assertEqual(
                collect_urls(args),
                [
                    "https://example.test/one",
                    "https://example.test/two",
                    "https://example.test/three",
                ],
            )

    def test_invalid_url_reports_line(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "recordings.txt"
            path.write_text("not-a-url\n", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "line 1"):
                load_urls_file(str(path))


if __name__ == "__main__":
    unittest.main()
