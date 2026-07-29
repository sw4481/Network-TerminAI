"""learn verb: extract structured feature state using Genie."""

from typing import Any, Dict

from ..connect import ensure_connected


def learn(testbed, device: str, feature: str, **kwargs) -> Dict[str, Any]:
    """Learn structured feature state using Genie.

    Args:
        testbed: Genie Testbed object
        device: Device name
        feature: Feature to learn (e.g., 'ospf', 'bgp', 'interface')
        **kwargs: Unused

    Returns:
        Envelope with learned feature state
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

        # Learn the feature
        learned = dev.learn(feature)

        # Convert to dict (Genie returns object with .info attribute)
        if hasattr(learned, "info"):
            data = learned.info
        else:
            data = learned

        return {
            "ok": True,
            "data": {
                "device": device,
                "feature": feature,
                "state": data,
            },
            "meta": {
                "verb": "learn",
                "device": device,
                "feature": feature,
            }
        }

    except Exception as exc:
        return {
            "ok": False,
            "error": {
                "code": "learn_failed",
                "message": str(exc),
                "hint": f"Feature '{feature}' may not be supported on this device or OS"
            }
        }
