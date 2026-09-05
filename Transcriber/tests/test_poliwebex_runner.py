from __future__ import annotations

import io
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from src.poliwebex_runner import PoliWebexRunner


class PoliWebexRunnerTests(unittest.TestCase):
    def test_child_output_does_not_leak_into_worker_stdout(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "poliwebex.js").write_text("// test fixture\n", encoding="utf-8")
            fake_node = root / "fake-node"
            fake_node.write_text(
                "#!/bin/sh\n"
                "printf '\\033[34mProject powered by @sup3rgiu\\033[0m\\n'\n"
                "printf 'Authentication failed\\n'\n"
                "exit 4\n",
                encoding="utf-8",
            )
            fake_node.chmod(0o755)

            runner = PoliWebexRunner(root)
            runner.node_bin = fake_node
            captured_stdout = io.StringIO()

            with redirect_stdout(captured_stdout):
                with self.assertRaisesRegex(RuntimeError, "Authentication failed") as raised:
                    runner.download_single(
                        "https://example.test/recording",
                        root / "downloads",
                    )

            self.assertEqual(captured_stdout.getvalue(), "")
            self.assertNotIn("Project powered by", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
