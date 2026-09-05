import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from src.config import from_env


class BundledConfigurationTests(unittest.TestCase):
    def test_included_downloader_is_found_without_environment_or_current_directory(self):
        previous = Path.cwd()
        try:
            with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
                os.chdir(directory)
                config = from_env(None, None)
                self.assertTrue((config.poliwebex_path / "poliwebex.js").is_file())
        finally:
            os.chdir(previous)

    def test_explicit_downloader_overrides_environment(self):
        with patch.dict(os.environ, {"POLIWEBEX_PATH": "/environment"}):
            self.assertEqual(from_env("/explicit", None).poliwebex_path, Path("/explicit"))

    def test_environment_override_is_preserved(self):
        with patch.dict(os.environ, {"POLIWEBEX_PATH": "/custom"}):
            self.assertEqual(from_env(None, None).poliwebex_path, Path("/custom"))
