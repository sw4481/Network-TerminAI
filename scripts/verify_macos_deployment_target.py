#!/usr/bin/env python3
"""Reject portable-sidecar Mach-O files newer than the advertised macOS floor."""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path


MINOS_RE = re.compile(r"^\s*minos\s+([0-9]+(?:\.[0-9]+){0,2})\s*$", re.MULTILINE)


def parse_version(value: str) -> tuple[int, int, int]:
    parts = value.split(".")
    if not 1 <= len(parts) <= 3 or any(not part.isdigit() for part in parts):
        raise ValueError(f"invalid macOS version: {value!r}")
    return tuple(int(part) for part in parts + ["0"] * (3 - len(parts)))  # type: ignore[return-value]


def parse_minos(output: str) -> list[tuple[int, int, int]]:
    return [parse_version(match.group(1)) for match in MINOS_RE.finditer(output)]


def format_version(version: tuple[int, int, int]) -> str:
    return ".".join(str(part) for part in version[:2])


def macho_candidates(root: Path) -> list[Path]:
    candidates = {
        path
        for pattern in ("*.so", "*.dylib")
        for path in root.rglob(pattern)
        if path.is_file()
    }
    bin_dir = root / "bin"
    if bin_dir.is_dir():
        candidates.update(path for path in bin_dir.iterdir() if path.is_file())
    return sorted(candidates)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="portable Python root")
    parser.add_argument("--maximum", required=True, help="advertised macOS floor")
    args = parser.parse_args()

    try:
        maximum = parse_version(args.maximum)
    except ValueError as exc:
        parser.error(str(exc))

    root = args.root.resolve()
    if not root.is_dir():
        parser.error(f"portable Python root does not exist: {root}")
    if shutil.which("vtool") is None:
        parser.error("vtool is required to inspect Mach-O deployment targets")

    inspected = 0
    violations: list[tuple[tuple[int, int, int], Path]] = []
    highest = (0, 0, 0)
    for candidate in macho_candidates(root):
        result = subprocess.run(
            ["vtool", "-show-build", str(candidate)],
            check=False,
            capture_output=True,
            text=True,
        )
        versions = parse_minos(result.stdout)
        if not versions:
            continue
        inspected += 1
        file_minimum = max(versions)
        highest = max(highest, file_minimum)
        if file_minimum > maximum:
            violations.append((file_minimum, candidate.relative_to(root)))

    if inspected == 0:
        print("error: no Mach-O files were inspected", file=sys.stderr)
        return 1
    if violations:
        print(
            f"error: {len(violations)} Mach-O file(s) require newer than "
            f"macOS {format_version(maximum)}:",
            file=sys.stderr,
        )
        for minimum, path in violations[:30]:
            print(f"  macOS {format_version(minimum)}: {path}", file=sys.stderr)
        return 1

    print(
        f"macOS deployment target OK: {inspected} Mach-O files, "
        f"highest minimum {format_version(highest)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
