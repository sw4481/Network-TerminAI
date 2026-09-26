#!/usr/bin/env python3
"""Add the signed Debian updater record to a Tauri latest.json manifest."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path


class MetadataError(RuntimeError):
    pass


def load_object(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise MetadataError(f"cannot read {path}: {exc}") from exc
    if not isinstance(value, dict):
        raise MetadataError(f"{path} must contain a JSON object")
    return value


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--latest-json", required=True, type=Path)
    parser.add_argument("--release-json", required=True, type=Path)
    parser.add_argument("--signature", required=True, type=Path)
    args = parser.parse_args()

    try:
        latest = load_object(args.latest_json)
        release = load_object(args.release_json)
        platforms = latest.get("platforms")
        assets = release.get("assets")
        if not isinstance(platforms, dict):
            raise MetadataError("latest.json platforms must be an object")
        if not isinstance(assets, list):
            raise MetadataError("release assets are missing")

        deb_assets = [
            asset
            for asset in assets
            if isinstance(asset, dict)
            and isinstance(asset.get("name"), str)
            and asset["name"].endswith(".deb")
        ]
        if len(deb_assets) != 1:
            raise MetadataError(
                f"expected exactly one Debian installer asset, found {len(deb_assets)}"
            )
        deb = deb_assets[0]
        deb_name = str(deb["name"])

        matching_signature_assets = [
            asset
            for asset in assets
            if isinstance(asset, dict) and asset.get("name") == f"{deb_name}.sig"
        ]
        if len(matching_signature_assets) != 1:
            raise MetadataError(
                "release must contain exactly one signature asset matching "
                f"{deb_name}.sig"
            )

        url = deb.get("url") or deb.get("browser_download_url")
        if not isinstance(url, str) or not url.strip():
            raise MetadataError("Debian installer asset has no download URL")
        try:
            signature = args.signature.read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise MetadataError(f"cannot read {args.signature}: {exc}") from exc
        if len(signature) < 40:
            raise MetadataError("Debian updater signature is empty or malformed")

        record = {
            "signature": signature,
            "url": url,
        }
        platforms["linux-x86_64"] = record
        platforms["linux-x86_64-deb"] = record
        args.latest_json.write_text(
            json.dumps(latest, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        print(f"Debian updater metadata OK: {deb_name}")
    except (MetadataError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
