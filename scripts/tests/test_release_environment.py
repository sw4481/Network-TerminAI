from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "check-release-environment.sh"


class ReleaseEnvironmentTests(unittest.TestCase):
    def run_check(self, **values: str) -> subprocess.CompletedProcess[str]:
        env = {"PATH": os.environ.get("PATH", "/usr/bin:/bin")}
        env.update(values)
        return subprocess.run(
            [str(SCRIPT)],
            cwd=ROOT,
            env=env,
            text=True,
            capture_output=True,
            check=False,
        )

    def test_release_requires_updater_oauth_and_apple_values(self) -> None:
        result = self.run_check(
            TAURI_SIGNING_PRIVATE_KEY="private-value",
            TAURI_SIGNING_PRIVATE_KEY_PASSWORD="password-value",
            TERMINAI_GITHUB_CLIENT_ID="public-client-id",
            APPLE_CERTIFICATE="certificate-value",
            APPLE_CERTIFICATE_PASSWORD="certificate-password",
            APPLE_SIGNING_IDENTITY="Developer ID Application: Example",
            APPLE_ID="release@example.invalid",
            APPLE_PASSWORD="app-password",
            APPLE_TEAM_ID="TEAMID1234",
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("release credential preflight OK", result.stdout)
        self.assertNotIn("private-value", result.stdout + result.stderr)
        self.assertNotIn("password-value", result.stdout + result.stderr)

    def test_missing_value_reports_only_its_name(self) -> None:
        result = self.run_check(
            TAURI_SIGNING_PRIVATE_KEY="private-value",
            TAURI_SIGNING_PRIVATE_KEY_PASSWORD="password-value",
            TERMINAI_GITHUB_CLIENT_ID="public-client-id",
        )

        self.assertNotEqual(result.returncode, 0)
        self.assertIn("APPLE_CERTIFICATE", result.stderr)
        self.assertNotIn("private-value", result.stdout + result.stderr)
        self.assertNotIn("password-value", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
