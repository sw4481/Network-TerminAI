"""find-interface-by-ip verb: locate interface with given IP."""

from typing import Any, Dict

from ..connect import ensure_connected


def find_interface_by_ip(testbed, device: str, ip: str, **kwargs) -> Dict[str, Any]:
    """Find which interface has a given IP address.

    Args:
        testbed: Genie Testbed object
        device: Device name
        ip: IP address to search for
        **kwargs: Unused

    Returns:
        Envelope with matching interface(s)
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

        # Parse interface brief
        interfaces = dev.parse("show ip interface brief")
        matches = []

        for intf_name, intf_data in interfaces.get("interface", {}).items():
            intf_ip = intf_data.get("ip_address", "")
            if intf_ip == ip:
                matches.append({
                    "interface": intf_name,
                    "ip": intf_ip,
                    "status": intf_data.get("status", ""),
                })

        return {
            "ok": True,
            "data": {
                "device": device,
                "ip": ip,
                "matches": matches,
            },
            "meta": {
                "verb": "find-interface-by-ip",
                "count": len(matches),
            }
        }

    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "code": "search_failed",
                "message": str(exc),
                "hint": "Check device connectivity and command support"
            }
        }
