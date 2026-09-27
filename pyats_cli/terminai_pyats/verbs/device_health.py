"""device-health verb: get platform, interface, and routing summary."""

from typing import Any, Dict

from ..connect import ensure_connected


def device_health(testbed, device: str, **kwargs) -> Dict[str, Any]:
    """Get device health snapshot (platform, interfaces, routing summary).

    Args:
        testbed: Genie Testbed object
        device: Device name
        **kwargs: Unused

    Returns:
        Envelope with health snapshot
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
    health = {}

    try:
        ensure_connected(dev)

        # Gather basic health info
        try:
            version = dev.parse("show version")
            health["platform"] = {
                "version": version.get("version", {}).get("version", "unknown"),
                "uptime": version.get("version", {}).get("uptime", "unknown"),
            }
        except Exception:
            health["platform"] = {"error": "Could not parse version"}

        try:
            interfaces = dev.parse("show ip interface brief")
            up_count = 0
            down_count = 0
            for intf_data in interfaces.get("interface", {}).values():
                status = intf_data.get("status", "").lower()
                if "up" in status:
                    up_count += 1
                else:
                    down_count += 1
            health["interfaces"] = {
                "up": up_count,
                "down": down_count,
                "total": up_count + down_count,
            }
        except Exception:
            health["interfaces"] = {"error": "Could not parse interfaces"}

        return {
            "ok": True,
            "data": {
                "device": device,
                "health": health,
            },
            "meta": {
                "verb": "device-health",
                "device": device,
            }
        }

    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "code": "health_check_failed",
                "message": str(exc),
                "hint": "Check device connectivity"
            }
        }
