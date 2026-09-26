"""UML / diagram rendering helper for the code-execution sandbox (via Kroki).

Available to EVERY agent (installed unconditionally alongside drawio/proxmox).
Renders PlantUML, Mermaid, Graphviz, C4, sequence/ER/network diagrams, etc.
through the hosted Kroki service (https://kroki.io). Kroki encodes the diagram
source the same way draw.io does: URI-safe base64 of a raw-DEFLATE stream, so we
reuse that scheme and build a GET URL the frontend can render inline as an SVG
<img>.

Exposed to agent code as a pre-imported `uml` object:

    uml.render("@startuml\\nA -> B\\n@enduml", diagram_type="plantuml", title="Flow")
    uml.plantuml("a -> b")        # convenience
    uml.graphviz("digraph{a->b}")
    uml.mermaid("graph TD; A-->B")

Each call builds the Kroki SVG URL, emits a `diagram` event (format "image") so
the app renders it inline, and returns the payload dict.
"""
from __future__ import annotations

import base64
import sys
import types
import zlib
from typing import Any, Callable, Dict, Optional

import requests

DEFAULT_KROKI_BASE = "https://kroki.io"

# Diagram engines Kroki supports (subset we advertise). Kroki accepts more; any
# string is passed through, these are just the common ones for validation hints.
SUPPORTED_TYPES = (
    "plantuml", "mermaid", "graphviz", "c4plantuml", "ditaa", "erd",
    "nomnoml", "seqdiag", "actdiag", "blockdiag", "nwdiag", "packetdiag",
    "rackdiag", "bpmn", "bytefield", "d2", "dbml", "structurizr", "wavedrom",
)


def _kroki_encode(source: str) -> str:
    """URL-safe base64 of a zlib (DEFLATE) stream — Kroki's GET encoding."""
    compressed = zlib.compress(source.encode("utf-8"), 9)
    return base64.urlsafe_b64encode(compressed).decode("ascii")


def build_kroki_url(source: str, diagram_type: str, fmt: str = "svg",
                    base_url: str = DEFAULT_KROKI_BASE) -> str:
    """Build a Kroki GET URL that renders ``source`` as ``fmt`` (svg/png)."""
    encoded = _kroki_encode(source)
    return f"{base_url}/{diagram_type}/{fmt}/{encoded}"


class UmlHelper:
    """Sandbox-facing UML/diagram helper. Renders via Kroki, previews inline."""

    def __init__(
        self,
        emit: Optional[Callable[[Dict[str, Any]], None]] = None,
        base_url: str = DEFAULT_KROKI_BASE,
    ) -> None:
        self._emit = emit
        self._base = base_url

    def render(self, source: str, diagram_type: str = "plantuml",
               title: str = "diagram") -> Dict[str, Any]:
        """Render any Kroki-supported diagram. Returns {title, format, url, image_url}.

        Kroki is called via POST (the source goes in the body), so there is NO
        URL-length limit — a GET URL embeds the whole diagram in the path and
        414s on anything sizeable. The returned SVG is inlined as a data: URI in
        image_url so the frontend renders it without a giant URL. `url` keeps a
        short-only GET link for "open externally" (omitted when it would 414).
        """
        if not isinstance(source, str) or not source.strip():
            raise ValueError("diagram source must be a non-empty string")
        dt = (diagram_type or "plantuml").strip().lower()

        image_url = ""
        error = None
        try:
            resp = requests.post(
                f"{self._base}/{dt}/svg",
                data=source.encode("utf-8"),
                headers={"Content-Type": "text/plain"},
                timeout=30,
            )
            if resp.status_code == 200:
                b64 = base64.b64encode(resp.content).decode("ascii")
                image_url = f"data:image/svg+xml;base64,{b64}"
            else:
                error = f"Kroki HTTP {resp.status_code}: {resp.text[:200]}"
        except Exception as e:
            error = f"Kroki request failed: {e}"

        # A GET URL is handy for "open externally" but 414s when long, so only
        # offer it for compact diagrams.
        get_url = build_kroki_url(source, dt, "svg", self._base)
        external_url = get_url if len(get_url) < 4000 else ""

        payload: Dict[str, Any] = {
            "title": str(title) if title else "diagram",
            "format": "image",
            "xml": None,
            "source": source,
            "url": external_url,
            "image_url": image_url,
        }
        if error:
            payload["error"] = error
        if self._emit is not None and image_url:
            self._emit({"type": "diagram", **payload})
        return payload

    # -- convenience wrappers --------------------------------------------------

    def plantuml(self, source: str, title: str = "diagram") -> Dict[str, Any]:
        return self.render(source, "plantuml", title)

    def mermaid(self, source: str, title: str = "diagram") -> Dict[str, Any]:
        return self.render(source, "mermaid", title)

    def graphviz(self, source: str, title: str = "diagram") -> Dict[str, Any]:
        return self.render(source, "graphviz", title)

    def c4(self, source: str, title: str = "diagram") -> Dict[str, Any]:
        return self.render(source, "c4plantuml", title)

    def help(self) -> str:
        return (
            "uml.render(source, diagram_type='plantuml', title=...) renders a diagram "
            "via Kroki and previews it inline. diagram_type is one of: "
            + ", ".join(SUPPORTED_TYPES) + ". Convenience: uml.plantuml(src), "
            "uml.mermaid(src), uml.graphviz(src), uml.c4(src)."
        )


def install_uml(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[Dict[str, Any]], None]] = None,
    base_url: str = DEFAULT_KROKI_BASE,
) -> "UmlHelper":
    """Register a `uml` helper as a sandbox global AND an importable module."""
    helper = UmlHelper(emit=emit, base_url=base_url)
    globals_dict["uml"] = helper

    module = types.ModuleType("uml")
    module.render = helper.render
    module.plantuml = helper.plantuml
    module.mermaid = helper.mermaid
    module.graphviz = helper.graphviz
    module.c4 = helper.c4
    module.build_kroki_url = build_kroki_url
    module.uml = helper
    sys.modules["uml"] = module

    return helper
