#!/usr/bin/env python3
"""Validate a packaged Python, ccie_sidecar origin, heartbeat, and ping protocol."""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path


def fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("python", type=Path, help="portable Python executable")
    parser.add_argument(
        "--expected-root",
        type=Path,
        required=True,
        help="directory that must contain the imported ccie_sidecar package",
    )
    args = parser.parse_args()

    executable = args.python.resolve()
    expected_root = args.expected_root.resolve()
    if not executable.is_file():
        return fail(f"portable Python does not exist: {executable}")

    origin_probe = (
        "import ccie_sidecar, json; "
        "print(json.dumps({'module': ccie_sidecar.__file__}))"
    )
    try:
        origin = subprocess.run(
            [str(executable), "-c", origin_probe],
            check=True,
            capture_output=True,
            text=True,
            timeout=30,
        )
        module_path = Path(json.loads(origin.stdout)["module"]).resolve()
    except (subprocess.SubprocessError, KeyError, json.JSONDecodeError, OSError) as exc:
        return fail(f"cannot import ccie_sidecar with bundled Python: {exc}")

    try:
        module_path.relative_to(expected_root)
    except ValueError:
        return fail(
            f"ccie_sidecar resolved outside the bundle: {module_path} (root {expected_root})"
        )

    request_id = "portable-sidecar-smoke"
    request = json.dumps({"id": request_id, "method": "ping", "params": {}}) + "\n"
    try:
        result = subprocess.run(
            [str(executable), "-m", "ccie_sidecar"],
            input=request,
            capture_output=True,
            text=True,
            timeout=45,
        )
    except subprocess.SubprocessError as exc:
        return fail(f"sidecar ping process failed: {exc}")
    if result.returncode != 0:
        detail = result.stderr.strip() or f"exit code {result.returncode}"
        return fail(f"sidecar ping failed: {detail}")

    messages: list[dict] = []
    for line_number, line in enumerate(result.stdout.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            return fail(f"stdout line {line_number} is not JSON: {exc}")
        if not isinstance(message, dict):
            return fail(f"stdout line {line_number} is not a JSON object")
        messages.append(message)

    heartbeat = next(
        (message for message in messages if message.get("type") == "sidecar.heartbeat"),
        None,
    )
    if heartbeat is None:
        return fail("startup heartbeat was not emitted")
    payload = heartbeat.get("payload")
    if not isinstance(payload, dict) or not isinstance(payload.get("version"), str):
        return fail("startup heartbeat has no sidecar version")
    if not payload["version"].strip():
        return fail("startup heartbeat sidecar version is empty")

    pong = next(
        (
            message
            for message in messages
            if message.get("id") == request_id
            and message.get("type") == "done"
            and message.get("result") == "pong"
        ),
        None,
    )
    if pong is None:
        return fail("sidecar did not return a successful pong")

    print(
        "portable sidecar OK: "
        f"version={payload['version']} module={module_path.relative_to(expected_root)}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
