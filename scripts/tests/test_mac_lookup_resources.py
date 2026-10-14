from __future__ import annotations

import csv
import json
from pathlib import Path
import tempfile
import unittest

try:
    from scripts.build_mac_registry_seed import MacRegistrySeedBuilder
except ModuleNotFoundError as error:
    if error.name != "scripts.build_mac_registry_seed":
        raise
    MacRegistrySeedBuilder = None

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = {
    "MA-L": ("oui.csv", "001122"),
    "MA-M": ("mam.csv", "0011223"),
    "MA-S": ("oui36.csv", "001122345"),
    "IAB": ("iab.csv", "0050C2001"),
    "CID": ("cid.csv", "021122"),
}


class MacRegistrySeedTests(unittest.TestCase):
    def make_sources(self, directory: Path) -> None:
        for registry, (filename, prefix) in FIXTURES.items():
            destination = directory / registry / filename
            destination.parent.mkdir()
            with destination.open("w", encoding="utf-8", newline="") as stream:
                writer = csv.writer(stream)
                writer.writerow(["Registry", "Assignment", "Organization Name", "Organization Address"])
                writer.writerow([registry, prefix, "Example, Inc.", "10 Example Road\nExample City US"])

    def test_builds_complete_snapshot_with_quoted_addresses(self) -> None:
        self.assertIsNotNone(MacRegistrySeedBuilder, "offline registry seed builder is missing")
        with tempfile.TemporaryDirectory() as temporary:
            self.make_sources(Path(temporary))
            snapshot = MacRegistrySeedBuilder(Path(temporary)).build()
        self.assertEqual(snapshot["schema_version"], 1)
        self.assertEqual(len(snapshot["records"]), 5)
        self.assertEqual(len(snapshot["sources"]), 5)
        self.assertTrue(snapshot["snapshot_at"].endswith("Z"))
        self.assertEqual(snapshot["records"][0]["organization"], "Example, Inc.")
        self.assertIn("\nExample City", snapshot["records"][0]["organization_address"])
        self.assertTrue(all(source["url"].startswith("https://standards-oui.ieee.org/") for source in snapshot["sources"]))

    def test_rejects_invalid_assignment_without_writing_partial_seed(self) -> None:
        self.assertIsNotNone(MacRegistrySeedBuilder, "offline registry seed builder is missing")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.make_sources(directory)
            (directory / "MA-S" / "oui36.csv").write_text(
                "Registry,Assignment,Organization Name,Organization Address\nMA-S,NOTHEX,Example,US\n",
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "MA-S"):
                MacRegistrySeedBuilder(directory).build()

    def test_preserves_shared_prefix_registrations_without_arbitrary_vendor_choice(self) -> None:
        self.assertIsNotNone(MacRegistrySeedBuilder, "offline registry seed builder is missing")
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            self.make_sources(directory)
            with (directory / "MA-L" / "oui.csv").open("a", encoding="utf-8", newline="") as stream:
                csv.writer(stream).writerow(["MA-L", "001122", "Shared Registration", "Second City US"])
            snapshot = MacRegistrySeedBuilder(directory).build()
        assignment = snapshot["records"][0]
        self.assertEqual(len(snapshot["records"]), 5)
        self.assertEqual(assignment["organization"], "Example, Inc. | Shared Registration")
        self.assertIn("Example, Inc.:\n10 Example", assignment["organization_address"])
        self.assertIn("Shared Registration:\nSecond City US", assignment["organization_address"])

    def test_shipped_seed_contains_all_registries_and_real_assignments(self) -> None:
        seed = ROOT / "resources" / "mac-registry.json"
        self.assertTrue(seed.is_file(), "bundled offline registry seed is missing")
        snapshot = json.loads(seed.read_text(encoding="utf-8"))
        self.assertEqual(snapshot["schema_version"], 1)
        self.assertEqual({source["registry"] for source in snapshot["sources"]}, set(FIXTURES))
        self.assertGreater(len(snapshot["records"]), 50000)
        records = {(row["registry"], row["prefix"]): row for row in snapshot["records"]}
        self.assertIn("Cisco", records[("MA-L", "00000C")]["organization"])
        self.assertIn("Apple", records[("MA-L", "0017F2")]["organization"])


class MacLookupWiringTests(unittest.TestCase):
    def test_native_menu_event_reaches_a_mounted_panel_and_registered_commands(self) -> None:
        frontend = (ROOT / "src" / "App.tsx").read_text(encoding="utf-8")
        backend = (ROOT / "src-tauri" / "src" / "lib.rs").read_text(encoding="utf-8")
        modules = (ROOT / "src-tauri" / "src" / "commands" / "mod.rs").read_text(encoding="utf-8")
        self.assertIn('"mac_lookup_open", "MAC Address Lookup"', backend)
        self.assertIn('window.emit("menu:mac_lookup_open", ())', backend)
        self.assertIn("listen('menu:mac_lookup_open'", frontend)
        self.assertIn("<MacLookupPanel", frontend)
        self.assertIn("pub mod mac_lookup;", modules)
        for command in ("mac_lookup", "mac_registry_info", "mac_registry_update"):
            self.assertIn(f"commands::mac_lookup::{command}", backend)


if __name__ == "__main__":
    unittest.main()
