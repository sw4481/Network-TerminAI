#!/usr/bin/env python3
"""Build the offline seed from separately downloaded official IEEE CSV files."""
from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import json
from pathlib import Path
import re


class MacRegistrySeedBuilder:
    SOURCES = (
        ("MA-L", "oui.csv", 6, "https://standards-oui.ieee.org/oui/oui.csv"),
        ("MA-M", "mam.csv", 7, "https://standards-oui.ieee.org/oui28/mam.csv"),
        ("MA-S", "oui36.csv", 9, "https://standards-oui.ieee.org/oui36/oui36.csv"),
        ("IAB", "iab.csv", 9, "https://standards-oui.ieee.org/iab/iab.csv"),
        ("CID", "cid.csv", 6, "https://standards-oui.ieee.org/cid/cid.csv"),
    )
    HEADERS = ["Registry", "Assignment", "Organization Name", "Organization Address"]

    def __init__(self, downloads: Path) -> None:
        self.downloads = downloads

    def build(self) -> dict:
        records = []
        sources = []
        for registry, filename, width, url in self.SOURCES:
            groups: dict[str, list[tuple[str, str]]] = {}
            with (self.downloads / registry / filename).open(encoding="utf-8", newline="") as stream:
                reader = csv.DictReader(stream)
                if reader.fieldnames != self.HEADERS:
                    raise ValueError(f"{registry}: unexpected IEEE CSV headers")
                for row in reader:
                    if None in row or any(value is None for value in row.values()):
                        raise ValueError(f"{registry}: invalid CSV row width")
                    prefix = row["Assignment"].strip().upper()
                    organization = row["Organization Name"].strip()
                    address = row["Organization Address"].strip()
                    if (row["Registry"].strip() != registry
                            or not re.fullmatch(rf"[0-9A-F]{{{width}}}", prefix)
                            or not organization
                            or len(organization.encode("utf-8")) > 1024
                            or len(address.encode("utf-8")) > 8192
                            or any(ord(character) < 32 and character not in "\n\r\t"
                                   for character in organization + address)):
                        raise ValueError(f"{registry}: invalid assignment {prefix!r}")
                    registrations = groups.setdefault(prefix, [])
                    if (organization, address) not in registrations:
                        registrations.append((organization, address))
            if not groups:
                raise ValueError(f"{registry}: empty registry")
            for prefix, registrations in groups.items():
                organization = " | ".join(name for name, _ in registrations)
                address = (registrations[0][1] if len(registrations) == 1 else
                           "\n\n".join(f"{name}:\n{location}" for name, location in registrations))
                if len(organization.encode("utf-8")) > 1024 or len(address.encode("utf-8")) > 8192:
                    raise ValueError(f"{registry}: oversized shared assignment {prefix!r}")
                records.append({
                    "registry": registry, "prefix": prefix,
                    "organization": organization, "organization_address": address,
                })
            sources.append({"registry": registry, "url": url})
        return {
            "schema_version": 1,
            "snapshot_at": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
            "sources": sources,
            "records": records,
        }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("downloads", type=Path, help="Root containing MA-L/oui.csv, MA-M/mam.csv, etc.")
    parser.add_argument("output", type=Path, help="Destination JSON seed")
    arguments = parser.parse_args()
    snapshot = MacRegistrySeedBuilder(arguments.downloads).build()
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(f"Wrote {len(snapshot['records']):,} assignments to {arguments.output}")
