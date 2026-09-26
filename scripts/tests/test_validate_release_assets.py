from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "validate_release_assets.py"
BASE_URL = "https://github.com/sw4481/Network-TerminAI/releases/download/v1.0.0"


def asset(name: str) -> dict[str, object]:
    return {
        "id": abs(hash(name)),
        "name": name,
        "browser_download_url": f"{BASE_URL}/{name}",
    }


def release_payload(*, include_checksums: bool) -> dict[str, object]:
    names = [
        "latest.json",
        "TerminAI_1.0.0_aarch64.dmg",
        "TerminAI.app.tar.gz",
        "TerminAI.app.tar.gz.sig",
        "TerminAI_1.0.0_x64-setup.exe",
        "TerminAI_1.0.0_x64.nsis.zip",
        "TerminAI_1.0.0_x64.nsis.zip.sig",
        "TerminAI_1.0.0_amd64.deb",
        "TerminAI_1.0.0_amd64.deb.sig",
    ]
    if include_checksums:
        names.append("SHA256SUMS.txt")
    return {
        "tag_name": "v1.0.0",
        "draft": True,
        "name": "TerminAI v1.0.0",
        "body": "Release notes",
        "assets": [asset(name) for name in names],
    }


def updater_payload() -> dict[str, object]:
    signature = "s" * 64
    return {
        "version": "1.0.0",
        "notes": "Release notes",
        "platforms": {
            "darwin-aarch64": {
                "signature": signature,
                "url": f"{BASE_URL}/TerminAI.app.tar.gz",
            },
            "windows-x86_64": {
                "signature": signature,
                "url": f"{BASE_URL}/TerminAI_1.0.0_x64.nsis.zip",
            },
            "linux-x86_64": {
                "signature": signature,
                "url": f"{BASE_URL}/TerminAI_1.0.0_amd64.deb",
            },
            "darwin-aarch64-app": {
                "signature": signature,
                "url": f"{BASE_URL}/TerminAI.app.tar.gz",
            },
            "windows-x86_64-nsis": {
                "signature": signature,
                "url": f"{BASE_URL}/TerminAI_1.0.0_x64.nsis.zip",
            },
            "linux-x86_64-deb": {
                "signature": signature,
                "url": f"{BASE_URL}/TerminAI_1.0.0_amd64.deb",
            },
        },
    }


class ReleaseAssetValidationTests(unittest.TestCase):
    def run_validation(self, *, include_checksums: bool) -> subprocess.CompletedProcess[str]:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            latest = root / "latest.json"
            release = root / "release.json"
            notes = root / "notes.md"
            latest.write_text(json.dumps(updater_payload()), encoding="utf-8")
            release.write_text(
                json.dumps(release_payload(include_checksums=include_checksums)),
                encoding="utf-8",
            )
            notes.write_text("Release notes\n", encoding="utf-8")
            return subprocess.run(
                [
                    sys.executable,
                    str(SCRIPT),
                    "--tag",
                    "v1.0.0",
                    "--latest-json",
                    str(latest),
                    "--release-json",
                    str(release),
                    "--expected-notes",
                    str(notes),
                ],
                cwd=ROOT,
                text=True,
                capture_output=True,
                check=False,
            )

    def test_accepts_complete_zero_cost_release_matrix(self) -> None:
        result = self.run_validation(include_checksums=True)

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("release asset validation OK", result.stdout)

    def test_rejects_release_without_checksum_manifest(self) -> None:
        result = self.run_validation(include_checksums=False)

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("missing release asset: SHA256SUMS.txt", result.stderr)


if __name__ == "__main__":
    unittest.main()
