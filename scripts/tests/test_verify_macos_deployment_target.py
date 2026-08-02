from __future__ import annotations

import unittest

from scripts.verify_macos_deployment_target import parse_minos, parse_version


class ParseVersionTests(unittest.TestCase):
    def test_normalizes_release_components(self) -> None:
        self.assertEqual(parse_version("15"), (15, 0, 0))
        self.assertEqual(parse_version("15.2"), (15, 2, 0))
        self.assertEqual(parse_version("15.2.1"), (15, 2, 1))

    def test_rejects_non_numeric_versions(self) -> None:
        with self.assertRaises(ValueError):
            parse_version("15.beta")


class ParseVtoolOutputTests(unittest.TestCase):
    def test_reads_every_architecture_minimum(self) -> None:
        output = """
example.dylib (architecture x86_64):
    minos 13.2
example.dylib (architecture arm64):
    minos 15.0
"""
        self.assertEqual(parse_minos(output), [(13, 2, 0), (15, 0, 0)])

    def test_ignores_sdk_versions(self) -> None:
        output = """
    minos 12.0
      sdk 15.5
"""
        self.assertEqual(parse_minos(output), [(12, 0, 0)])


if __name__ == "__main__":
    unittest.main()
