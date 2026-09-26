"""run-show-command-multi verb: execute show command on multiple devices in parallel."""

from typing import Any, Dict, List
from concurrent.futures import ThreadPoolExecutor, as_completed

from ..connect import ensure_connected


def run_show_command_multi(testbed, devices: List[str], command: str, **kwargs) -> Dict[str, Any]:
    """Run a show command on multiple devices in parallel.

    Args:
        testbed: Genie Testbed object
        devices: List of device names
        command: Show command to execute
        **kwargs: Unused

    Returns:
        Envelope with results keyed by device name
    """
    results = {}
    errors = {}

    def run_on_device(device_name: str):
        if device_name not in testbed.devices:
            return device_name, None, f"Device '{device_name}' not found"

        dev = testbed.devices[device_name]
        try:
            ensure_connected(dev)

            # Try Genie parsing first
            try:
                parsed = dev.parse(command)
                return device_name, {"parsed": parsed, "format": "genie"}, None
            except Exception:
                # Fall back to raw
                raw = dev.execute(command)
                return device_name, {"output": raw, "format": "raw"}, None

        except Exception as exc:
            return device_name, None, str(exc)

    # Execute in parallel with max 10 workers
    with ThreadPoolExecutor(max_workers=min(10, len(devices))) as executor:
        futures = {executor.submit(run_on_device, dev): dev for dev in devices}

        for future in as_completed(futures):
            device_name, result, error = future.result()
            if error:
                errors[device_name] = error
            else:
                results[device_name] = result

    return {
        "ok": True,
        "data": {
            "command": command,
            "results": results,
            "errors": errors,
        },
        "meta": {
            "verb": "run-show-command-multi",
            "devices": len(devices),
            "succeeded": len(results),
            "failed": len(errors),
        }
    }
