"""list-devices verb: enumerate all devices in testbed."""

from typing import Any, Dict


def list_devices(testbed, **kwargs) -> Dict[str, Any]:
    """List all devices in the testbed.

    Args:
        testbed: Genie Testbed object
        **kwargs: Unused (verb takes no arguments)

    Returns:
        Envelope with list of device names and basic info
    """
    devices = []
    for name, device in testbed.devices.items():
        devices.append({
            "name": name,
            "os": device.os,
            "type": getattr(device, "type", "unknown"),
        })

    return {
        "ok": True,
        "data": devices,
        "meta": {
            "verb": "list-devices",
            "count": len(devices),
        }
    }
