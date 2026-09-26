from ntc_templates.parse import parse_output
from .errors import TextFSMUnsupportedError

VENDOR_MAP = {
    ("cisco", "iosxe"): "cisco_xe",
    ("cisco", "ios"): "cisco_ios",
    ("cisco", "nxos"): "cisco_nxos",
    ("juniper", "junos"): "juniper_junos",
    ("arista", "eos"): "arista_eos",
}

def parse(vendor: str, platform: str, command: str, raw: str) -> dict:
    key = (vendor.lower(), platform.lower())
    platform_key = VENDOR_MAP.get(key)
    if platform_key is None:
        raise TextFSMUnsupportedError(f"no template mapping for {key}")
    try:
        data = parse_output(platform=platform_key, command=command, data=raw)
    except Exception as exc:
        raise TextFSMUnsupportedError(str(exc)) from exc
    if not data:
        raise TextFSMUnsupportedError(f"template matched 0 rows for {command}")
    return {"parser": "textfsm", "command": command, "data": data}
