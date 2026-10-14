#!/usr/bin/env python3
"""Ad-hoc sign portable Python's native code before Tauri seals the outer app."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


class MacResourceSigner:
    MACHO_MAGICS = {
        b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe",  # thin 32-bit
        b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe",  # thin 64-bit
        b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca",  # fat 32-bit
        b"\xca\xfe\xba\xbf", b"\xbf\xba\xfe\xca",  # fat 64-bit
    }

    def __init__(self, root: Path) -> None:
        # The build's top-level python path may itself be a symlink.
        self.root = root.resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError(f"Python root is not a directory: {root}")

    def native_files(self) -> list[Path]:
        natives: set[Path] = set()

        def walk_error(error: OSError) -> None:
            raise error

        for directory, dirs, files in os.walk(self.root, followlinks=False, onerror=walk_error):
            for name in dirs:
                path = Path(directory) / name
                if path.is_symlink() and not path.resolve().is_relative_to(self.root):
                    # Never inspect arbitrary external trees to guess whether
                    # their directory link might expose unsealed native code.
                    raise ValueError(f"directory symlink escapes Python root: {path}")
            for name in files:
                path = Path(directory) / name
                resolved = path.resolve()
                if not resolved.is_relative_to(self.root):
                    raise ValueError(f"symlink escapes Python root: {path}")
                if not resolved.is_file():
                    continue
                with resolved.open("rb") as file:
                    if file.read(4) in self.MACHO_MAGICS:
                        natives.add(resolved)
        # Complete discovery/escape validation before any mutation. Canonical
        # paths deduplicate aliases; deepest native resources are signed first.
        return sorted(natives, key=lambda path: (-len(path.relative_to(self.root).parts), str(path)))

    def sign(self) -> None:
        self._process(sign=True)

    def verify(self) -> None:
        self._process(sign=False)

    def _process(self, *, sign: bool) -> None:
        natives = self.native_files()
        if not natives:
            raise ValueError(f"no Mach-O resources found in {self.root}")
        for path in natives:
            if sign:
                # Do not preserve hardened-runtime/library-validation flags:
                # portable Python must load these ad-hoc signed extensions.
                subprocess.run(
                    ["codesign", "--force", "--sign", "-", "--options", "0", str(path)],
                    check=True,
                )
            subprocess.run(["codesign", "--verify", "--strict", str(path)], check=True)
        print(f"macOS native resources {'signed' if sign else 'verified'}: {len(natives)}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("root", type=Path, help="portable Python root")
    parser.add_argument("--verify-only", action="store_true", help="inspect already sealed resources without signing")
    args = parser.parse_args()
    if sys.platform != "darwin" and not args.verify_only:
        print("macOS resource signing skipped on this platform")
        return 0
    try:
        signer = MacResourceSigner(args.root)
        if args.verify_only:
            signer.verify()
        else:
            signer.sign()
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
