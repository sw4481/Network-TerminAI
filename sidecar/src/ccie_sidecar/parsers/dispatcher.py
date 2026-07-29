from . import genie_adapter, textfsm_adapter
from .errors import GenieUnsupportedError, TextFSMUnsupportedError, NoParserError

def parse_show(vendor: str, platform: str, command: str, raw: str) -> dict:
    try:
        return genie_adapter.parse(vendor, platform, command, raw)
    except GenieUnsupportedError:
        pass
    try:
        return textfsm_adapter.parse(vendor, platform, command, raw)
    except TextFSMUnsupportedError as exc:
        raise NoParserError(f"no parser for vendor={vendor} platform={platform} cmd={command}: {exc}") from exc
