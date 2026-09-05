from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from src.models import LectureArtifacts
from src.prompt_pack import write_metadata


class WriteMetadataTests(unittest.TestCase):
    def _artifacts(self, root: Path) -> LectureArtifacts:
        return LectureArtifacts(
            lecture_id="lec-1",
            source_url="https://example.test/recording",
            media_file=root / "lec.mp4",
            transcript_txt=root / "lec.txt",
            transcript_json=root / "lec.json",
            prompt_markdown=None,
            notes_markdown=root / "lec.md",
            metadata_json=root / "lec.metadata.json",
        )

    def test_records_claude_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata_path = root / "lec.metadata.json"
            write_metadata(
                self._artifacts(root),
                [],
                metadata_path,
                notes_model="sonnet",
                notes_provider="claude-cli",
            )
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["notes_generator"],
                {"provider": "claude-cli", "model": "sonnet", "reasoning_effort": None},
            )

    def test_provider_defaults_to_codex_cli(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            metadata_path = root / "lec.metadata.json"
            write_metadata(
                self._artifacts(root),
                [],
                metadata_path,
                notes_model="gpt-5.6-luna",
                notes_reasoning_effort="high",
            )
            payload = json.loads(metadata_path.read_text(encoding="utf-8"))
            self.assertEqual(
                payload["notes_generator"],
                {
                    "provider": "codex-cli",
                    "model": "gpt-5.6-luna",
                    "reasoning_effort": "high",
                },
            )


if __name__ == "__main__":
    unittest.main()
