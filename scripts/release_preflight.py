#!/usr/bin/env python3
"""Version, tag, changelog, and updater release-contract checks for TerminAI."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
EXPECTED_ENDPOINT = (
    "https://github.com/sw4481/Network-TerminAI/releases/latest/download/latest.json"
)
EXPECTED_IDENTIFIER = "com.ccie.terminal"
EXPECTED_PACKAGE = "ccie-terminal"
EXPECTED_MACOS_MINIMUM = "15.0"

SEMVER_RE = re.compile(
    r"^(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)\."
    r"(0|[1-9][0-9]*)"
    r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
    r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$"
)


class PreflightError(RuntimeError):
    """A release contract was not satisfied."""


def validate_semver(version: str) -> str:
    match = SEMVER_RE.fullmatch(version)
    if not match:
        raise PreflightError(f"invalid semantic version: {version!r}")
    prerelease = match.group(4)
    if prerelease:
        for identifier in prerelease.split("."):
            if identifier.isdigit() and len(identifier) > 1 and identifier.startswith("0"):
                raise PreflightError(
                    f"numeric prerelease identifiers cannot have leading zeroes: {version!r}"
                )
    return version


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        try:
            display_path = path.relative_to(ROOT)
        except ValueError:
            display_path = path
        raise PreflightError(f"cannot read {display_path}: {exc}") from exc


def read_toml(path: Path) -> dict:
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        raise PreflightError(f"cannot read {path.relative_to(ROOT)}: {exc}") from exc


def changelog_notes(version: str) -> str:
    validate_semver(version)
    changelog = (ROOT / "CHANGELOG.md").read_text(encoding="utf-8")
    pattern = re.compile(
        rf"^## \[{re.escape(version)}\](?:\s+-[^\n]*)?\s*$\n"
        rf"(?P<body>.*?)(?=^## \[|\Z)",
        re.MULTILINE | re.DOTALL,
    )
    match = pattern.search(changelog)
    if not match:
        raise PreflightError(f"CHANGELOG.md has no versioned [{version}] section")
    notes = match.group("body").strip()
    if not notes:
        raise PreflightError(f"CHANGELOG.md [{version}] section is empty")
    return notes


def manifest_versions() -> dict[str, str]:
    package = read_json(ROOT / "package.json")
    tauri = read_json(ROOT / "src-tauri" / "tauri.conf.json")
    cargo = read_toml(ROOT / "src-tauri" / "Cargo.toml")
    lock = read_toml(ROOT / "src-tauri" / "Cargo.lock")

    if package.get("name") != EXPECTED_PACKAGE:
        raise PreflightError("package.json historical package name changed")
    if cargo.get("package", {}).get("name") != EXPECTED_PACKAGE:
        raise PreflightError("Cargo.toml historical package name changed")
    if tauri.get("identifier") != EXPECTED_IDENTIFIER:
        raise PreflightError("Tauri identifier changed; upgrades would move user data")

    macos_minimum = tauri.get("bundle", {}).get("macOS", {}).get(
        "minimumSystemVersion"
    )
    if macos_minimum != EXPECTED_MACOS_MINIMUM:
        raise PreflightError(
            f"Tauri macOS minimum must be {EXPECTED_MACOS_MINIMUM}"
        )

    endpoints = tauri.get("plugins", {}).get("updater", {}).get("endpoints", [])
    if endpoints != [EXPECTED_ENDPOINT]:
        raise PreflightError(
            "Tauri updater endpoint must be the TerminAI latest.json URL"
        )

    root_packages = [
        item
        for item in lock.get("package", [])
        if item.get("name") == EXPECTED_PACKAGE and "source" not in item
    ]
    if len(root_packages) != 1:
        raise PreflightError(
            "Cargo.lock must contain exactly one local ccie-terminal package entry"
        )

    versions = {
        "package.json": str(package.get("version", "")),
        "src-tauri/tauri.conf.json": str(tauri.get("version", "")),
        "src-tauri/Cargo.toml": str(cargo.get("package", {}).get("version", "")),
        "src-tauri/Cargo.lock": str(root_packages[0].get("version", "")),
    }
    for name, version in versions.items():
        try:
            validate_semver(version)
        except PreflightError as exc:
            raise PreflightError(f"{name}: {exc}") from exc
    return versions


def run_git(*args: str) -> str:
    try:
        return subprocess.check_output(
            ["git", *args], cwd=ROOT, text=True, stderr=subprocess.STDOUT
        ).strip()
    except subprocess.CalledProcessError as exc:
        detail = exc.output.strip() or f"git {' '.join(args)} failed"
        raise PreflightError(detail) from exc


def check_release(
    *,
    tag: str | None,
    latest_json: Path | None,
    verify_git: bool,
    check_changelog: bool,
) -> str:
    versions = manifest_versions()
    unique_versions = set(versions.values())
    if len(unique_versions) != 1:
        detail = ", ".join(f"{name}={value}" for name, value in versions.items())
        raise PreflightError(f"release versions disagree: {detail}")
    version = unique_versions.pop()

    if tag:
        if not tag.startswith("v"):
            raise PreflightError(f"release tag must start with v: {tag!r}")
        tag_version = validate_semver(tag[1:])
        if tag_version != version:
            raise PreflightError(
                f"tag {tag} does not match manifest version {version}"
            )
        if verify_git:
            tag_type = run_git("cat-file", "-t", f"refs/tags/{tag}")
            if tag_type != "tag":
                raise PreflightError(f"{tag} must be an annotated Git tag")
            tag_commit = run_git("rev-parse", f"refs/tags/{tag}^{{commit}}")
            head_commit = run_git("rev-parse", "HEAD")
            if tag_commit != head_commit:
                raise PreflightError(
                    f"{tag} points to {tag_commit}, but checkout is {head_commit}"
                )

    if check_changelog:
        changelog_notes(version)

    if latest_json:
        updater = read_json(latest_json.resolve())
        updater_version = str(updater.get("version", ""))
        if updater_version != version:
            raise PreflightError(
                f"latest.json version {updater_version!r} does not match {version}"
            )
        notes = updater.get("notes")
        if not isinstance(notes, str) or not notes.strip():
            raise PreflightError("latest.json release notes are empty")

    return version


def replace_package_version(text: str, version: str) -> str:
    section = re.search(r"(?m)^\[package\]\s*$", text)
    if not section:
        raise PreflightError("Cargo.toml has no [package] section")
    next_section = re.search(r"(?m)^\[[^\n]+\]\s*$", text[section.end() :])
    end = section.end() + next_section.start() if next_section else len(text)
    body = text[section.end() : end]
    replaced, count = re.subn(
        r'(?m)^(version\s*=\s*")[^"]+(")\s*$',
        rf"\g<1>{version}\g<2>",
        body,
        count=1,
    )
    if count != 1:
        raise PreflightError("Cargo.toml [package] version is missing or ambiguous")
    return text[: section.end()] + replaced + text[end:]


def replace_lock_version(text: str, version: str) -> str:
    matches: list[tuple[int, int, str]] = []
    for block in re.finditer(
        r"(?ms)^\[\[package\]\]\n.*?(?=^\[\[package\]\]|\Z)", text
    ):
        body = block.group(0)
        if re.search(rf'(?m)^name = "{re.escape(EXPECTED_PACKAGE)}"$', body) and not re.search(
            r"(?m)^source = ", body
        ):
            matches.append((block.start(), block.end(), body))
    if len(matches) != 1:
        raise PreflightError(
            "Cargo.lock local ccie-terminal package entry is missing or ambiguous"
        )
    start, end, body = matches[0]
    replaced, count = re.subn(
        r'(?m)^(version = ")[^"]+(")$',
        rf"\g<1>{version}\g<2>",
        body,
        count=1,
    )
    if count != 1:
        raise PreflightError("Cargo.lock package version is missing")
    return text[:start] + replaced + text[end:]


def atomic_write(path: Path, content: str) -> None:
    mode = path.stat().st_mode
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=path.parent, delete=False
        ) as handle:
            handle.write(content)
            temporary = handle.name
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def set_version(version: str) -> None:
    validate_semver(version)
    package_path = ROOT / "package.json"
    tauri_path = ROOT / "src-tauri" / "tauri.conf.json"
    cargo_path = ROOT / "src-tauri" / "Cargo.toml"
    lock_path = ROOT / "src-tauri" / "Cargo.lock"

    package = read_json(package_path)
    tauri = read_json(tauri_path)
    cargo_text = cargo_path.read_text(encoding="utf-8")
    lock_text = lock_path.read_text(encoding="utf-8")

    package["version"] = version
    tauri["version"] = version
    outputs = {
        package_path: json.dumps(package, indent=2, ensure_ascii=False) + "\n",
        tauri_path: json.dumps(tauri, indent=2, ensure_ascii=False) + "\n",
        cargo_path: replace_package_version(cargo_text, version),
        lock_path: replace_lock_version(lock_text, version),
    }
    for path, content in outputs.items():
        atomic_write(path, content)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    check_parser = subparsers.add_parser("check", help="check the release contract")
    check_parser.add_argument("--tag", help="expected annotated release tag")
    check_parser.add_argument(
        "--latest-json", type=Path, help="generated updater metadata to validate"
    )
    check_parser.add_argument(
        "--no-git", action="store_true", help="skip tag object/commit checks"
    )
    check_parser.add_argument(
        "--skip-changelog",
        action="store_true",
        help="skip versioned release-note checks (version bump only)",
    )

    notes_parser = subparsers.add_parser(
        "notes", help="print a version's CHANGELOG section"
    )
    notes_parser.add_argument("version")

    validate_parser = subparsers.add_parser(
        "validate-version", help="validate one semantic version"
    )
    validate_parser.add_argument("version")

    set_parser = subparsers.add_parser(
        "set-version", help="synchronize all release manifests and Cargo.lock"
    )
    set_parser.add_argument("version")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        if args.command == "check":
            version = check_release(
                tag=args.tag,
                latest_json=args.latest_json,
                verify_git=not args.no_git,
                check_changelog=not args.skip_changelog,
            )
            print(f"release preflight OK: TerminAI {version}")
        elif args.command == "notes":
            print(changelog_notes(args.version))
        elif args.command == "validate-version":
            validate_semver(args.version)
        elif args.command == "set-version":
            set_version(args.version)
        else:  # pragma: no cover - argparse guarantees a known command
            raise PreflightError(f"unsupported command: {args.command}")
    except (PreflightError, OSError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
