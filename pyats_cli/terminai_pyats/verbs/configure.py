"""configure verb: apply config to device (high blast radius)."""

from typing import Any, Dict

from ..connect import ensure_connected


def configure(testbed, device: str, config: str, **kwargs) -> Dict[str, Any]:
    """Apply configuration commands to a device.

    Args:
        testbed: Genie Testbed object
        device: Device name
        config: Configuration commands (one per line)
        **kwargs: Unused

    Returns:
        Envelope with configuration result
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

        # Apply configuration
        output = dev.configure(config)

        return {
            "ok": True,
            "data": {
                "device": device,
                "config": config,
                "output": output,
            },
            "meta": {
                "verb": "configure",
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
