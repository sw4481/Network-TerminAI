"""rollback-config verb: restore last configure-with-diff snapshot (high blast radius)."""

import os
from typing import Any, Dict

from ..connect import ensure_connected


def rollback_config(testbed, device: str, **kwargs) -> Dict[str, Any]:
    """Rollback to the last configure-with-diff snapshot.

    Args:
        testbed: Genie Testbed object
        device: Device name
        **kwargs: Can include _snapshot_dir for testing

    Returns:
        Envelope with rollback result
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

    # Check for before snapshot
    snapshot_dir = kwargs.get("_snapshot_dir") or os.path.expanduser("~/.ccie-terminal/pyats/snapshots")
    before_path = os.path.join(snapshot_dir, f"{device}_before.cfg")

    if not os.path.exists(before_path):
        return {
            "ok": False,
            "error": {
                "code": "no_snapshot",
                "message": f"No rollback snapshot found for device '{device}'",
                "hint": "Run configure-with-diff first to create a rollback point"
            }
        }

    dev = testbed.devices[device]

    try:
        ensure_connected(dev)

        # Read before config
        with open(before_path, "r") as f:
            before_config = f.read()

        # Apply before config (full replace)
        # Note: This is a simplified rollback. Production would use config replace.
        dev.configure("no running-config")
        output = dev.configure(before_config)

        return {
            "ok": True,
            "data": {
                "device": device,
                "snapshot": before_path,
                "output": output,
            },
            "meta": {
                "verb": "rollback-config",
                "device": device,
            }
        }

    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "code": "rollback_failed",
                "message": str(exc),
                "hint": "Rollback may have partially applied. Check device state."
            }
        }
