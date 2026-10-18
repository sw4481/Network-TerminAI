"""Run Cisco's Genie parsers on Windows without pyATS.

Cisco publishes pyATS and the compiled Genie core (``genie.metaparser``,
``genie.parsergen``) for Linux and macOS only. The parser library itself,
``genie.libs.parser``, is pure Python and installs on Windows, but every parser
imports that core. This package re-implements the small part of the core the
parsers use (all Apache 2.0) and registers it under the original module names.

``install()`` is only called when the real Genie import fails, so Linux and
macOS keep using pyATS unchanged.
"""
import importlib
import json
import os
import re
import sys
import types

from ..errors import GenieUnsupportedError
from . import abstract, exceptions, metaparser, parsergen, schemaengine, stubs, util

_installed = False
_index: list[tuple[re.Pattern, dict]] | None = None


def _package(name: str, **attrs) -> types.ModuleType:
    module = types.ModuleType(name)
    module.__path__ = []  # marks it as a package so submodule imports resolve
    module.__dict__.update(attrs)
    return module


def install() -> None:
    """Register the compat modules under the genie/pyats names the parsers import."""
    global _installed
    if _installed:
        return
    metaparser.util = util
    util.schemaengine = schemaengine
    util.exceptions = exceptions
    pyats_utils = _package("pyats.utils", exceptions=exceptions, import_utils=stubs)
    pyats_log = _package("pyats.log", utils=stubs)
    modules = {
        "genie.metaparser": metaparser,
        "genie.metaparser.util": util,
        "genie.metaparser.util.schemaengine": schemaengine,
        "genie.metaparser.util.exceptions": exceptions,
        "genie.parsergen": parsergen,
        "genie.abstract": abstract,
        "genie.abstract.package": abstract,
        "genie.abstract.decorator": abstract,
        "genie.json": _package("genie.json", make_json=stubs),
        "genie.json.make_json": stubs,
        "genie.base": _package("genie.base"),
        "pyats": _package("pyats", utils=pyats_utils, log=pyats_log,
                          configuration=stubs, __terminai_compat__=True),
        "pyats.utils": pyats_utils,
        "pyats.utils.exceptions": exceptions,
        "pyats.utils.import_utils": stubs,
        "pyats.log": pyats_log,
        "pyats.log.utils": stubs,
        "pyats.configuration": stubs,
    }
    for name, module in modules.items():
        sys.modules.setdefault(name, module)
    import genie.libs.parser  # noqa: F401  # fails here if the parser library is missing

    # Some parsers use attribute access (`import genie.parsergen` then
    # `genie.parsergen.oper_fill_tabular`), so hang the modules off `genie` too.
    genie = sys.modules["genie"]
    for name in ("metaparser", "parsergen", "abstract", "json", "base"):
        setattr(genie, name, sys.modules[f"genie.{name}"])
    _installed = True


def _load_index() -> list[tuple[re.Pattern, dict]]:
    """Command patterns from genie.libs.parser's parsers.json, exact commands first."""
    global _index
    if _index is None:
        from genie.libs import parser as parser_pkg

        path = os.path.join(os.path.dirname(parser_pkg.__file__), "parsers.json")
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        entries = []
        for command, info in data.items():
            pattern = re.sub(r"\\\{(\w+)\\\}", r"(?P<\1>\\S+)", re.escape(command))
            entries.append((command.count("{"), re.compile(f"^{pattern}$"), info))
        entries.sort(key=lambda e: e[0])
        _index = [(pattern, info) for _, pattern, info in entries]
    return _index


def find_parser(platform: str, command: str) -> tuple[type, dict]:
    """Return the parser class for ``command`` on ``platform`` and its arguments."""
    command = " ".join(command.split())
    for pattern, info in _load_index():
        match = pattern.match(command)
        if not match:
            continue
        entry = info.get("folders", info).get(platform)
        if not isinstance(entry, dict) or "class" not in entry:
            continue
        module = importlib.import_module(f"{entry['package']}.{entry['module_name']}")
        return getattr(module, entry["class"]), match.groupdict()
    raise GenieUnsupportedError(f"no genie parser for platform={platform} cmd={command}")
