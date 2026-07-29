"""run-show-command verb: execute show command with optional Genie parsing."""

from typing import Any, Dict

from ..connect import ensure_connected


def run_show_command(testbed, device: str, command: str, **kwargs) -> Dict[str, Any]:
    """Run a show command on a device (Genie-parsed when available).

    Args:
        testbed: Genie Testbed object
        device: Device name
        command: Show command to execute
        **kwargs: Unused

    Returns:
        Envelope with parsed output (if Genie parser available) or raw text
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

        # Try Genie parsing first
        try:
            parsed = dev.parse(command)
            return {
                "ok": True,
                "data": {
                    "device": device,
                    "command": command,
                    "parsed": parsed,
                    "format": "genie"
                },
                "meta": {
                    "verb": "run-show-command",
                    "device": device,
                }
            }
        except Exception:
            # Fall back to raw execute if no parser available
            raw = dev.execute(command)
            return {
                "ok": True,
                "data": {
                    "device": device,
                    "command": command,
                    "output": raw,
                    "format": "raw"
                },
                "meta": {
                    "verb": "run-show-command",
                    "device": device,
                }
            }

    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "code": "command_failed",
                "message": str(exc),
                "hint": "Check device connectivity and command syntax"
            }
        }
