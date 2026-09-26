"""
draw.io diagram helper for the code-execution sandbox.

Reimplements the URL-building logic of the `@drawio/mcp` tool server natively
in Python so AI agents can produce draw.io diagrams without bundling Node.js.

The encoding here MUST stay byte-for-byte compatible with how draw.io's editor
reads the `#create=` fragment, which is the same scheme `@drawio/mcp` uses
(jgraph/drawio-mcp, mcp-tool-server/src/index.js):

    compressData(data):
        encoded    = encodeURIComponent(data)   # URI-encode FIRST
        compressed = pako.deflateRaw(encoded)    # raw DEFLATE, no zlib header
        return base64(compressed)                # standard base64

    generateDrawioUrl(data, type):
        createObj = { type, compressed: true, data: compressData(data) }
        url = BASE + "?grid=0&pv=0&border=10&edit=_blank"
                   + "#create=" + encodeURIComponent(JSON.stringify(createObj))

`type` is one of "xml" | "csv" | "mermaid"; draw.io's editor imports
accordingly when the URL is opened.

Exposed to agent code as a pre-imported `drawio` object in the sandbox:

    drawio.diagram(xml="<mxGraphModel>...</mxGraphModel>", title="Topology")
    drawio.from_mermaid("graph TD; A-->B", title="Flow")
    drawio.from_csv("name,parent\\nA,\\nB,A", title="Org chart")

Each call builds the URL, emits a structured ``diagram`` event to the frontend
(which renders it inline and offers an "Open in draw.io" button), and returns
the payload dict so the agent can also print the URL if it wants.
"""
from __future__ import annotations

import base64
import json
import urllib.parse
import zlib
from typing import Any, Callable, Dict, Optional

# JavaScript's encodeURIComponent leaves these characters unescaped. Python's
# urllib.parse.quote escapes a different default set, so we pass an explicit
# safe set to match encodeURIComponent exactly. (encodeURIComponent does NOT
# escape: A-Z a-z 0-9 - _ . ! ~ * ' ( ) — quote always keeps the alphanumerics
# and -_.~, so we only need to add !*'() to the safe set.)
_ENCODE_URI_COMPONENT_SAFE = "!~*'()-_.abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"

DEFAULT_BASE_URL = "https://app.diagrams.net/"

# One place to correct the fragment scheme if draw.io ever changes it.
_VALID_FORMATS = ("xml", "csv", "mermaid")


def _encode_uri_component(text: str) -> str:
    """Match JavaScript's encodeURIComponent()."""
    return urllib.parse.quote(text, safe=_ENCODE_URI_COMPONENT_SAFE)


def _compress_data(data: str) -> str:
    """
    URI-encode, raw-DEFLATE, then standard-base64 the diagram source.

    Mirrors `compressData` in @drawio/mcp. The URI-encode-first step is
    load-bearing: draw.io decodeURIComponent()s the inflated bytes on its end,
    so skipping it corrupts any diagram containing non-ASCII or reserved chars.
    """
    encoded = _encode_uri_component(data)
    # wbits=-15 => raw DEFLATE stream with no zlib header/checksum, which is
    # what pako.deflateRaw produces and what draw.io's pako.inflateRaw expects.
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    raw = compressor.compress(encoded.encode("utf-8")) + compressor.flush()
    return base64.b64encode(raw).decode("ascii")


def build_drawio_url(data: str, fmt: str, base_url: str = DEFAULT_BASE_URL) -> str:
    """
    Build an app.diagrams.net URL that opens ``data`` in the editor.

    Args:
        data: diagram source (mxGraph XML, CSV, or Mermaid text)
        fmt: one of "xml", "csv", "mermaid"
        base_url: draw.io base (override for self-hosted instances)

    Returns:
        Full URL with the ``#create=`` fragment.
    """
    if fmt not in _VALID_FORMATS:
        raise ValueError(f"unsupported diagram format: {fmt!r} (expected one of {_VALID_FORMATS})")

    create_obj = {"type": fmt, "compressed": True, "data": _compress_data(data)}
    fragment = _encode_uri_component(json.dumps(create_obj))
    return f"{base_url}?grid=0&pv=0&border=10&edit=_blank#create={fragment}"


class DrawioHelper:
    """
    Sandbox-facing draw.io helper.

    A single instance is injected into the code-execution globals as ``drawio``.
    It holds the loop's ``on_event`` callback so each diagram call streams a
    ``diagram`` event straight to the frontend panel.
    """

    def __init__(
        self,
        emit: Optional[Callable[[Dict[str, Any]], None]] = None,
        base_url: str = DEFAULT_BASE_URL,
    ) -> None:
        self._emit = emit
        self._base = base_url

    # -- public API agents call ------------------------------------------------

    def diagram(self, xml: str, title: str = "diagram") -> Dict[str, Any]:
        """Render native draw.io / mxGraph XML. Supports inline offline preview."""
        return self._make(xml, "xml", title, inline_xml=xml)

    def from_mermaid(self, mermaid: str, title: str = "diagram") -> Dict[str, Any]:
        """Render a Mermaid.js diagram. Opens in the editor (no offline preview)."""
        return self._make(mermaid, "mermaid", title, inline_xml=None)

    def from_csv(self, csv: str, title: str = "diagram") -> Dict[str, Any]:
        """Render a diagram from draw.io CSV import data (no offline preview)."""
        return self._make(csv, "csv", title, inline_xml=None)

    # -- internals -------------------------------------------------------------

    def _make(
        self,
        source: str,
        fmt: str,
        title: str,
        inline_xml: Optional[str],
    ) -> Dict[str, Any]:
        if not isinstance(source, str) or not source.strip():
            raise ValueError("diagram content must be a non-empty string")

        payload: Dict[str, Any] = {
            "title": str(title) if title else "diagram",
            "format": fmt,
            # Only native XML can be rendered offline by the bundled viewer;
            # csv/mermaid are editor-import features so xml stays None for them.
            "xml": inline_xml,
            "source": None if fmt == "xml" else source,
            "url": build_drawio_url(source, fmt, self._base),
        }

        if self._emit is not None:
            self._emit({"type": "diagram", **payload})

        return payload


def install_drawio(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[Dict[str, Any]], None]] = None,
    base_url: str = DEFAULT_BASE_URL,
) -> "DrawioHelper":
    """
    Make a `drawio` helper available to sandboxed code in every form an LLM is
    likely to reach for, so a wrong guess about how to access it still works:

        drawio.diagram(xml=...)                  # pre-loaded global (documented)
        import drawio; drawio.diagram(xml=...)   # module-style
        from drawio import drawio                 # the instance
        from drawio import diagram                # the function

    The instance is registered both as a sandbox global AND as a real module in
    ``sys.modules`` bound to this instance's ``emit``. Code execution is
    serialized on the main thread (SIGALRM-based timeout requires it), so the
    last-installed module always matches the active loop.
    """
    import sys
    import types

    helper = DrawioHelper(emit=emit, base_url=base_url)
    globals_dict["drawio"] = helper

    module = types.ModuleType("drawio")
    module.diagram = helper.diagram
    module.from_mermaid = helper.from_mermaid
    module.from_csv = helper.from_csv
    module.build_drawio_url = build_drawio_url
    # `from drawio import drawio` -> the instance (matches the common mistake).
    module.drawio = helper
    sys.modules["drawio"] = module

    return helper
