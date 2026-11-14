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

# Without pyATS (Windows), run the pure-Python genie.libs.parser on our own
# stand-in for the compiled Genie core. See genie_compat/__init__.py.
_compat = None
if _GENIE_IMPORT_ERROR is not None:
    try:
        from . import genie_compat

        genie_compat.install()
        _compat = genie_compat
        _GENIE_IMPORT_ERROR = None
    except Exception as compat_exc:
        _GENIE_IMPORT_ERROR = compat_exc


def parse(vendor: str, platform: str, command: str, raw: str) -> dict:
    if _GENIE_IMPORT_ERROR is not None:
        raise GenieUnsupportedError(
            f"genie/pyats is not installed on this platform: {_GENIE_IMPORT_ERROR}"
        )
    if vendor.lower() != "cisco":
        raise GenieUnsupportedError(f"genie does not support vendor={vendor}")
    if _compat is not None:
        return _parse_compat(platform, command, raw)
    try:
        device = Device("stub", os=platform.lower(), custom={"abstraction": {"order": ["os"]}})
        parser_cls, _ = get_parser(command, device)
    except Exception as exc:
        raise GenieUnsupportedError(str(exc)) from exc
    parser = parser_cls(device=device)
    parser.context_manager = {}
    data = parser.cli(output=raw)
    return {"parser": "genie", "command": command, "data": data}


def _parse_compat(platform: str, command: str, raw: str) -> dict:
    parser_cls, kwargs = _compat.find_parser(platform.lower(), command)
    parser = parser_cls(device=None)
    parser.context_manager = {}
    try:
        data = parser.cli(output=raw, **kwargs)
    except Exception as exc:  # a parser the stand-in core cannot run: use TextFSM
        raise GenieUnsupportedError(f"genie parser {parser_cls.__name__} failed: {exc}") from exc
    return {"parser": "genie", "command": command, "data": data}
