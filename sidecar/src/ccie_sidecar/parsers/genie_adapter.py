from .errors import GenieUnsupportedError

# pyATS/Genie has no Windows wheels, so it may be absent (see pyproject.toml).
# Import lazily-at-module-load but tolerate failure: when unavailable, parse()
# raises GenieUnsupportedError and the dispatcher falls through to TextFSM.
try:
    from genie.libs.parser.utils import get_parser
    from genie.conf.base import Device
    _GENIE_IMPORT_ERROR: Exception | None = None
except Exception as exc:  # ImportError on Windows; guard broadly to be safe
    get_parser = None  # type: ignore[assignment]
    Device = None  # type: ignore[assignment]
    _GENIE_IMPORT_ERROR = exc


def parse(vendor: str, platform: str, command: str, raw: str) -> dict:
    if _GENIE_IMPORT_ERROR is not None:
        raise GenieUnsupportedError(
            f"genie/pyats is not installed on this platform: {_GENIE_IMPORT_ERROR}"
        )
    if vendor.lower() != "cisco":
        raise GenieUnsupportedError(f"genie does not support vendor={vendor}")
    try:
        device = Device("stub", os=platform.lower(), custom={"abstraction": {"order": ["os"]}})
        parser_cls, _ = get_parser(command, device)
    except Exception as exc:
        raise GenieUnsupportedError(str(exc)) from exc
    parser = parser_cls(device=device)
    parser.context_manager = {}
    data = parser.cli(output=raw)
    return {"parser": "genie", "command": command, "data": data}
