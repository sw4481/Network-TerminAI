"""ping verb: ping destination from device."""

from typing import Any, Dict

from ..connect import ensure_connected


def ping(testbed, device: str, destination: str, **kwargs) -> Dict[str, Any]:
    """Ping a destination from a device.

    Args:
        testbed: Genie Testbed object
        device: Device name
        destination: Destination IP or hostname
        **kwargs: Unused

    Returns:
        Envelope with ping results
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

        # Execute ping command
        result = dev.ping(destination)

        return {
            "ok": True,
            "data": {
                "device": device,
                "destination": destination,
                "result": result,
            },
            "meta": {
                "verb": "ping",
                "device": device,
            }
        }

    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "code": "ping_failed",
                "message": str(exc),
                "hint": "Check device connectivity and destination reachability"
            }
        }
