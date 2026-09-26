from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "add_deb_updater_metadata.py"


class DebianUpdaterMetadataTests(unittest.TestCase):
    def run_patch(self, *, signature_asset_name: str) -> tuple[subprocess.CompletedProcess[str], dict]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            latest_path = root / "latest.json"
            release_path = root / "release.json"
            signature_path = root / "package.deb.sig"
            latest_path.write_text(
                json.dumps({"version": "1.0.0", "platforms": {}}),
                encoding="utf-8",
            )
            release_path.write_text(
                json.dumps(
                    {
                        "assets": [
                            {
                                "name": "TerminAI_1.0.0_amd64.deb",
                                "url": "https://api.github.test/assets/10",
                            },
                            {
                                "name": signature_asset_name,
                                "url": "https://api.github.test/assets/11",
                            },
                        ]
                    }
                ),
                encoding="utf-8",
            )
            signature_path.write_text("s" * 64, encoding="utf-8")
            result = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--latest-json",
                    str(latest_path),
                    "--release-json",
                    str(release_path),
                    "--signature",
                    str(signature_path),
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )
            return result, json.loads(latest_path.read_text(encoding="utf-8"))

    def test_adds_canonical_and_installer_specific_debian_records(self) -> None:
        result, latest = self.run_patch(
            signature_asset_name="TerminAI_1.0.0_amd64.deb.sig"
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        expected = {
            "signature": "s" * 64,
            "url": "https://api.github.test/assets/10",
        }
        self.assertEqual(latest["platforms"]["linux-x86_64"], expected)
        self.assertEqual(latest["platforms"]["linux-x86_64-deb"], expected)

    def test_rejects_a_signature_for_a_different_package(self) -> None:
        result, latest = self.run_patch(signature_asset_name="other.deb.sig")

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("signature asset matching", result.stderr)
        self.assertEqual(latest["platforms"], {})


if __name__ == "__main__":
    unittest.main()
