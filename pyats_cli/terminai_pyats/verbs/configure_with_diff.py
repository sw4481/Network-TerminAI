"""configure-with-diff verb: apply config and snapshot before/after (high blast radius)."""

import os
from typing import Any, Dict

from ..connect import ensure_connected


def configure_with_diff(testbed, device: str, config: str, **kwargs) -> Dict[str, Any]:
    """Apply configuration and return before/after diff (snapshots saved for rollback).

    Args:
        testbed: Genie Testbed object
        device: Device name
        config: Configuration commands (one per line)
        **kwargs: Can include _snapshot_dir for testing

    Returns:
        Envelope with before/after config and diff
    """
    if device not in testbed.devices:
        return {
            "ok": False,
            "error": {
                "code": "device_not_found",
                "message": f"Device '{device}' not found in testbed",
                "hint": "Use list-devices to see available devices"
            }
        }

    dev = testbed.devices[device]

    try:
        ensure_connected(dev)

        # Get before snapshot
        before = dev.execute("show running-config")

        # Apply configuration
        output = dev.configure(config)

        # Get after snapshot
        after = dev.execute("show running-config")

        # Save snapshots for rollback
        snapshot_dir = kwargs.get("_snapshot_dir") or os.path.expanduser("~/.ccie-terminal/pyats/snapshots")
        os.makedirs(snapshot_dir, exist_ok=True)

        before_path = os.path.join(snapshot_dir, f"{device}_before.cfg")
        after_path = os.path.join(snapshot_dir, f"{device}_after.cfg")

        with open(before_path, "w") as f:
            f.write(before)
        with open(after_path, "w") as f:
            f.write(after)

        # Compute simple line-based diff
        before_lines = before.splitlines()
        after_lines = after.splitlines()
        diff_lines = []

        # Simple diff: lines added/removed
        before_set = set(before_lines)
        after_set = set(after_lines)

        removed = before_set - after_set
        added = after_set - before_set

        for line in removed:
            diff_lines.append(f"- {line}")
        for line in added:
            diff_lines.append(f"+ {line}")

        return {
            "ok": True,
            "data": {
                "device": device,
                "config": config,
                "output": output,
                "diff": "\n".join(diff_lines),
                "snapshots": {
                    "before": before_path,
                    "after": after_path,
                }
            },
            "meta": {
                "verb": "configure-with-diff",
                "device": device,
            }
        }

    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "code": "configure_failed",
                "message": str(exc),
                "hint": "Check configuration syntax and device state"
            }
        }
