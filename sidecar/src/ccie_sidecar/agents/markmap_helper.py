"""Markmap (markdown mind-map) helper for the code-execution sandbox.

Available to EVERY agent (installed unconditionally alongside drawio/proxmox).
Turns a markdown outline into an interactive mind-map. The markdown is carried
to the frontend in a `diagram` event (format "markmap"); the DiagramPanel
renders it inline using the locally vendored markmap bundle (public/markmap/).

Exposed to agent code as a pre-imported `markmap` object:

    markmap.mindmap("# Root\\n## A\\n### A1\\n## B", title="OSPF")
    markmap.from_outline({"OSPF": {"LSA types": ["Type 1", "Type 2"]}})
"""
from __future__ import annotations

import sys
import types
from typing import Any, Callable, Dict, List, Optional, Union


def _outline_to_markdown(node: Union[Dict, List, str], depth: int = 1) -> str:
    """Convert a nested dict/list/str outline into markmap-friendly markdown."""
    lines: List[str] = []
    prefix = "#" * min(depth, 6)
    if isinstance(node, dict):
        for key, value in node.items():
            lines.append(f"{prefix} {key}")
            lines.append(_outline_to_markdown(value, depth + 1))
    elif isinstance(node, list):
        for item in node:
            if isinstance(item, (dict, list)):
                lines.append(_outline_to_markdown(item, depth))
            else:
                lines.append(f"{'  ' * (depth - 1)}- {item}")
    else:
        lines.append(f"{'  ' * (depth - 1)}- {node}")
    return "\n".join(l for l in lines if l)


class MarkmapHelper:
    """Sandbox-facing markmap helper. Renders a markdown mind-map inline."""

    def __init__(self, emit: Optional[Callable[[Dict[str, Any]], None]] = None) -> None:
        self._emit = emit

    def mindmap(self, markdown: str, title: str = "mind map") -> Dict[str, Any]:
        """Render a markmap from markdown. Returns {title, format, source, ...}."""
        if not isinstance(markdown, str) or not markdown.strip():
            raise ValueError("markmap markdown must be a non-empty string")
        payload: Dict[str, Any] = {
            "title": str(title) if title else "mind map",
            "format": "markmap",
            "xml": None,
            "source": markdown,
            # No external URL — rendered locally from the markdown source.
            "url": "",
            "image_url": None,
        }
        if self._emit is not None:
            self._emit({"type": "diagram", **payload})
        return payload

    def from_outline(self, outline: Union[Dict, List], title: str = "mind map") -> Dict[str, Any]:
        """Build markdown from a nested dict/list outline, then render it."""
        markdown = _outline_to_markdown(outline)
        return self.mindmap(markdown, title)

    def help(self) -> str:
        return (
            "markmap.mindmap(markdown, title=...) renders an interactive mind-map from "
            "a markdown outline (use #/##/### headings and - bullets) and previews it "
            "inline. markmap.from_outline(nested_dict_or_list, title=...) builds the "
            "markdown for you."
        )


def install_markmap(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[Dict[str, Any]], None]] = None,
) -> "MarkmapHelper":
    """Register a `markmap` helper as a sandbox global AND an importable module."""
    helper = MarkmapHelper(emit=emit)
    globals_dict["markmap"] = helper

    module = types.ModuleType("markmap")
    module.mindmap = helper.mindmap
    module.from_outline = helper.from_outline
    module.markmap = helper
    sys.modules["markmap"] = module

    return helper
