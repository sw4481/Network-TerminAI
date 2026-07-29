"""get-neighbors verb: retrieve CDP and LLDP neighbors."""

from typing import Any, Dict

from ..connect import ensure_connected


def get_neighbors(testbed, device: str, **kwargs) -> Dict[str, Any]:
    """Get CDP and LLDP neighbors for a device.

    Args:
        testbed: Genie Testbed object
        device: Device name
        **kwargs: Unused

    Returns:
        Envelope with CDP and LLDP neighbor data
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
    neighbors = {"cdp": {}, "lldp": {}}

    try:
        ensure_connected(dev)

        # Try CDP
        try:
            cdp = dev.parse("show cdp neighbors detail")
            neighbors["cdp"] = cdp
        except Exception:
            neighbors["cdp"] = {"error": "CDP not available or parsing failed"}

        # Try LLDP
        try:
            lldp = dev.parse("show lldp neighbors detail")
            neighbors["lldp"] = lldp
        except Exception:
            neighbors["lldp"] = {"error": "LLDP not available or parsing failed"}

        return {
            "ok": True,
            "data": {
                "device": device,
                "neighbors": neighbors,
            },
            "meta": {
                "verb": "get-neighbors",
                "device": device,
            }
        }

    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "code": "neighbors_failed",
                "message": str(exc),
                "hint": "Check device connectivity and CDP/LLDP configuration"
            }
        }
