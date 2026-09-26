"""configure-multi verb: apply config to multiple devices in parallel (high blast radius)."""

from typing import Any, Dict, List
from concurrent.futures import ThreadPoolExecutor, as_completed

from ..connect import ensure_connected


def configure_multi(testbed, devices: List[str], config: str, **kwargs) -> Dict[str, Any]:
    """Apply configuration to multiple devices in parallel.

    Args:
        testbed: Genie Testbed object
        devices: List of device names
        config: Configuration commands (one per line)
        **kwargs: Unused

    Returns:
        Envelope with results keyed by device name
    """
    results = {}
    errors = {}

    def configure_device(device_name: str):
        if device_name not in testbed.devices:
            return device_name, None, f"Device '{device_name}' not found"

        dev = testbed.devices[device_name]
        try:
            ensure_connected(dev)

            output = dev.configure(config)
            return device_name, {"output": output}, None

        except Exception as exc:
            return device_name, None, str(exc)

    # Execute in parallel with max 10 workers
    with ThreadPoolExecutor(max_workers=min(10, len(devices))) as executor:
        futures = {executor.submit(configure_device, dev): dev for dev in devices}

        for future in as_completed(futures):
            device_name, result, error = future.result()
            if error:
                errors[device_name] = error
            else:
                results[device_name] = result

    return {
        "ok": True,
        "data": {
            "config": config,
            "results": results,
            "errors": errors,
        },
        "meta": {
            "verb": "configure-multi",
            "devices": len(devices),
            "succeeded": len(results),
            "failed": len(errors),
        }
    }
