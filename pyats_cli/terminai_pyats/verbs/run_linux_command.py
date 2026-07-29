"""run-linux-command verb: execute Linux command on host device (medium blast radius)."""

from typing import Any, Dict

from ..connect import ensure_connected


def run_linux_command(testbed, device: str, command: str, **kwargs) -> Dict[str, Any]:
    """Run a Linux command on a host/server device.

    Args:
        testbed: Genie Testbed object
        device: Device name (should be a Linux host)
        command: Linux command to execute
        **kwargs: Unused

    Returns:
        Envelope with command output
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

        # Execute command
        output = dev.execute(command)

        return {
            "ok": True,
            "data": {
                "device": device,
                "command": command,
                "output": output,
            },
            "meta": {
                "verb": "run-linux-command",
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
