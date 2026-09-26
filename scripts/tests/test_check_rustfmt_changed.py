from __future__ import annotations

import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "check-rustfmt-changed.sh"


class CheckRustfmtChangedTests(unittest.TestCase):
    def test_root_commit_with_unavailable_base_exits_zero(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            (repo / "scripts").mkdir()
            (repo / "src-tauri").mkdir()
            shutil.copy2(SCRIPT, repo / "scripts" / "check-rustfmt-changed.sh")
            (repo / "src-tauri" / "lib.rs").write_text("fn main() {}\n", encoding="utf-8")

            subprocess.run(["git", "init"], cwd=repo, check=True, capture_output=True)
            subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True)
            subprocess.run(["git", "config", "user.name", "Test"], cwd=repo, check=True)
            subprocess.run(["git", "add", "."], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-m", "root"], cwd=repo, check=True, capture_output=True)

            result = subprocess.run(
                ["scripts/check-rustfmt-changed.sh", "HEAD^", "HEAD"],
                cwd=repo,
                text=True,
                capture_output=True,
                check=False,
            )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("rustfmt: no comparable base; nothing to compare", result.stdout)


if __name__ == "__main__":
    unittest.main()
