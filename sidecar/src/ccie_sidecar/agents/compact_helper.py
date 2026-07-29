"""Sandbox helper exposing graph-compact serialization to agent code.

Lets an agent shrink large tabular/graph results before printing them into the
LLM context, cutting token cost 40-60% on route tables, interface lists, BGP
peer tables, and topology payloads. Falls back to JSON on any non-tabular input,
so it is always safe to wrap a result in ``compact.encode(...)``.

Bound only when the master CCIE_CONTEXT_GRAPH flag is on (see code_exec). The
encoding itself is further gated by CCIE_GCF_MODE (default 'graph' when the
feature is on; 'off' disables and passes JSON through unchanged).
"""
from __future__ import annotations

import sys
import types
from typing import Any, Callable, Dict, Optional

from ccie_sidecar.serialize import graph_compact


class CompactHelper:
    """Sandbox-facing graph-compact serializer."""

    def __init__(self, default_mode: Optional[str] = None) -> None:
        self._mode = default_mode

    def encode(self, data: Any, mode: Optional[str] = None) -> str:
        """Return a compact string for tabular/graph data, else JSON. Never raises."""
        return graph_compact.encode(data, mode=mode if mode is not None else self._mode)

    def encode_with_stats(self, data: Any, mode: Optional[str] = None) -> Dict[str, Any]:
        """Encode and include token-savings stats (local estimate)."""
        return graph_compact.encode_with_stats(
            data, mode=mode if mode is not None else self._mode
        )

    def help(self) -> str:
        return (
            "compact.encode(data, mode=None) -> compact string for tabular "
            "(array of flat dicts) or graph (nodes+edges) data; returns JSON "
            "unchanged for anything else. Use it to print large route/interface/"
            "BGP/topology results with far fewer tokens. "
            "compact.encode_with_stats(data) -> {encoded, saved_pct, ...}."
        )


def install_compact(
    globals_dict: Dict[str, Any],
    emit: Optional[Callable[[Dict[str, Any]], None]] = None,
    default_mode: Optional[str] = None,
) -> "CompactHelper":
    """Register a `compact` helper as a sandbox global AND importable module."""
    helper = CompactHelper(default_mode=default_mode)
    globals_dict["compact"] = helper

    module = types.ModuleType("compact")
    module.encode = helper.encode
    module.encode_with_stats = helper.encode_with_stats
    module.help = helper.help
    module.compact = helper
    sys.modules["compact"] = module

    return helper
