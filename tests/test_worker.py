from __future__ import annotations

import unittest

from src.worker import _options


class WorkerOptionsTests(unittest.TestCase):
    def test_blank_provider_and_models_fall_back_to_defaults(self) -> None:
        options = _options(
            {
                "workspace_root": "/tmp/workspace",
                "output_root": "/tmp/output",
                "notes_provider": "",
                "codex_model": "",
                "claude_model": "   ",
            }
        )
        self.assertEqual(options.notes_provider, "codex")
        self.assertEqual(options.codex_model, "gpt-5.6-luna")
        self.assertEqual(options.claude_model, "sonnet")

    def test_explicit_provider_and_model_are_kept(self) -> None:
        options = _options(
            {
                "workspace_root": "/tmp/workspace",
                "output_root": "/tmp/output",
                "notes_provider": "claude",
                "claude_model": "opus",
            }
        )
        self.assertEqual(options.notes_provider, "claude")
        self.assertEqual(options.claude_model, "opus")


if __name__ == "__main__":
    unittest.main()
