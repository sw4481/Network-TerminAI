#!/usr/bin/env python3
"""Validate a draft GitHub release and its generated Tauri updater metadata."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from urllib.parse import urlparse


REQUIRED_PLATFORMS = {
    "darwin-aarch64": (".app.tar.gz",),
    "windows-x86_64": (".nsis.zip", "-setup.exe", "_setup.exe", ".exe"),
    "linux-x86_64": (".deb",),
    "darwin-aarch64-app": (".app.tar.gz",),
    "windows-x86_64-nsis": (".nsis.zip", "-setup.exe", "_setup.exe", ".exe"),
    "linux-x86_64-deb": (".deb",),
}


class ValidationError(RuntimeError):
    pass


def load_json(path: Path) -> dict | list:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValidationError(f"cannot read {path}: {exc}") from exc


def nonempty_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--latest-json", required=True, type=Path)
    parser.add_argument("--release-json", required=True, type=Path)
    parser.add_argument("--expected-notes", required=True, type=Path)
    args = parser.parse_args()

    try:
        if not args.tag.startswith("v"):
            raise ValidationError("release tag must start with v")
        version = args.tag[1:]
        latest = load_json(args.latest_json)
        release = load_json(args.release_json)
        if not isinstance(latest, dict) or not isinstance(release, dict):
            raise ValidationError("release and latest metadata must be JSON objects")

        if release.get("tag_name") != args.tag:
            raise ValidationError("GitHub release tag does not match the workflow tag")
        if release.get("draft") is not True:
            raise ValidationError("release must remain a draft until validation completes")
        if release.get("name") != f"TerminAI {args.tag}":
            raise ValidationError("GitHub release title must use the TerminAI identity")
        if not nonempty_text(release.get("body")):
            raise ValidationError("GitHub release notes are empty")
        expected_notes = args.expected_notes.read_text(encoding="utf-8").strip()
        if not expected_notes:
            raise ValidationError("versioned changelog notes are empty")
        if str(release.get("body")).strip() != expected_notes:
            raise ValidationError("GitHub release notes differ from CHANGELOG.md")

        if latest.get("version") != version:
            raise ValidationError("latest.json version does not match the release tag")
        if not nonempty_text(latest.get("notes")):
            raise ValidationError("latest.json release notes are empty")
        if str(latest.get("notes")).strip() != expected_notes:
            raise ValidationError("latest.json notes differ from CHANGELOG.md")
        platforms = latest.get("platforms")
        if not isinstance(platforms, dict):
            raise ValidationError("latest.json platforms must be an object")

        assets = release.get("assets")
        if not isinstance(assets, list):
            raise ValidationError("GitHub release assets are missing")
        names = {
            asset.get("name")
            for asset in assets
            if isinstance(asset, dict) and nonempty_text(asset.get("name"))
        }
        by_url: dict[str, str] = {}
        for asset in assets:
            if not isinstance(asset, dict) or not nonempty_text(asset.get("name")):
                continue
            name = str(asset["name"])
            for field in ("url", "browser_download_url"):
                value = asset.get(field)
                if nonempty_text(value):
                    by_url[str(value)] = name

        for required in ("latest.json", "SHA256SUMS.txt"):
            if required not in names:
                raise ValidationError(f"missing release asset: {required}")
        required_installers = {
            "macOS DMG": (".dmg",),
            "Windows NSIS": ("-setup.exe", "_setup.exe"),
            "Linux Debian package": (".deb",),
        }
        for label, suffixes in required_installers.items():
            if not any(
                str(name).endswith(suffix)
                for name in names
                for suffix in suffixes
            ):
                raise ValidationError(f"missing {label} installer asset")

        for platform, expected_suffixes in REQUIRED_PLATFORMS.items():
            record = platforms.get(platform)
            if not isinstance(record, dict):
                raise ValidationError(f"latest.json is missing {platform}")
            signature = record.get("signature")
            url = record.get("url")
            if not nonempty_text(signature) or len(str(signature).strip()) < 40:
                raise ValidationError(f"{platform} has no usable updater signature")
            if not nonempty_text(url):
                raise ValidationError(f"{platform} has no updater URL")

            asset_name = by_url.get(str(url))
            if asset_name is None:
                basename = Path(urlparse(str(url)).path).name
                if basename in names:
                    asset_name = basename
            if asset_name is None:
                raise ValidationError(
                    f"{platform} updater URL does not reference a release asset"
                )
            if not any(asset_name.endswith(suffix) for suffix in expected_suffixes):
                raise ValidationError(
                    f"{platform} updater asset has unexpected type: {asset_name}"
                )
            if f"{asset_name}.sig" not in names:
                raise ValidationError(f"missing updater signature asset: {asset_name}.sig")

        print(
            "release asset validation OK: "
            f"{len(names)} assets, {len(REQUIRED_PLATFORMS)} updater platforms"
        )
    except ValidationError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
