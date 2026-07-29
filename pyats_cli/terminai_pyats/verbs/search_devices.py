"""search-devices verb: search testbed by name pattern."""

from typing import Any, Dict


def search_devices(testbed, query: str, **kwargs) -> Dict[str, Any]:
    """Search devices by name pattern (case-insensitive substring match).

    Args:
        testbed: Genie Testbed object
        query: Search pattern
        **kwargs: Unused

    Returns:
        Envelope with matching devices
    """
    query_lower = query.lower()
    matches = []

    for name, device in testbed.devices.items():
        if query_lower in name.lower():
            matches.append({
                "name": name,
                "os": device.os,
                "type": getattr(device, "type", "unknown"),
            })

    return {
        "ok": True,
        "data": matches,
        "meta": {
            "verb": "search-devices",
            "query": query,
            "count": len(matches),
        }
    }
