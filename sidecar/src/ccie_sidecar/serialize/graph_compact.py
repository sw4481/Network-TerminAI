"""Graph-compact serialization for token-efficient LLM payloads.

Network data is overwhelmingly tabular (route tables, interface lists, BGP
peers) or graph-shaped (devices + links/sessions). Encoding it as pretty JSON
repeats every key on every row and spends tokens on braces/quotes. This module
re-encodes such payloads far more compactly:

- **table profile**: an array of uniform objects becomes a header row + one
  CSV-style line per record (keys stated once).
- **graph profile**: data that looks like nodes + edges (devices with a
  source/target-style link array) becomes a node list with local integer ids
  and an edge list using ``a>b`` arrows.
- **JSON fallback**: anything else, or ANY error, returns the original
  ``json.dumps`` output — the encoding is never allowed to lose data or raise.

Provider-agnostic: token accounting uses a local ``len // 4`` estimate, never a
provider ``count_tokens`` API. The payload shrink is what saves tokens on every
model; the estimate is only for the optional savings note.

Clean-room implementation of a general "compact graph/tabular encoding for LLM
tool output" technique. No third-party code is copied here; see THIRD_PARTY.md
for prior-art attribution.

Mode via ``CCIE_GCF_MODE`` (default resolved by the caller):
    full     - graph auto-detect + table profile
    graph    - graph auto-detect + table profile (same; no session state here)
    generic  - table profile only, never graph
    off      - JSON passthrough, encoding disabled
"""
from __future__ import annotations

import json
import os
from typing import Any, Dict, List, Optional, Tuple

# Keys that suggest an array element is an edge (has a source and a target).
_EDGE_SRC_KEYS = ("source", "src", "from", "local", "source_device", "a_device_ref")
_EDGE_TGT_KEYS = ("target", "tgt", "to", "remote", "target_device", "dest", "destination", "b_device_ref")
# Keys that give a node its natural identifier.
_ID_KEYS = ("id", "hostname", "router_id", "name", "device", "host", "node", "mgmt_ip")


def estimate_tokens(text: str) -> int:
    """Local, provider-neutral token estimate (~4 chars/token)."""
    return max(1, len(text) // 4)


def _resolve_mode(mode: Optional[str]) -> str:
    m = (mode if mode is not None else os.environ.get("CCIE_GCF_MODE", "off")).strip().lower()
    return m if m in ("full", "graph", "generic", "off") else "off"


def _is_row_list(data: Any) -> bool:
    """True when data is a non-empty list of flat, uniform-ish dicts."""
    if not isinstance(data, list) or len(data) < 2:
        return False
    if not all(isinstance(r, dict) for r in data):
        return False
    # Values must be scalar (no nested dict/list) to flatten cleanly.
    for r in data:
        for v in r.values():
            if isinstance(v, (dict, list)):
                return False
    return True


def _first_key(row: Dict[str, Any], candidates: Tuple[str, ...]) -> Optional[str]:
    for c in candidates:
        if c in row:
            return c
    return None


def _looks_like_edges(rows: List[Dict[str, Any]]) -> Tuple[Optional[str], Optional[str]]:
    """Return (src_key, tgt_key) if rows look edge-shaped, else (None, None)."""
    if not rows:
        return None, None
    sample = rows[0]
    src = _first_key(sample, _EDGE_SRC_KEYS)
    tgt = _first_key(sample, _EDGE_TGT_KEYS)
    if src and tgt:
        return src, tgt
    return None, None


def _csv_cell(v: Any) -> str:
    if v is None:
        return ""
    s = str(v)
    if any(c in s for c in (",", "\n", '"')):
        return '"' + s.replace('"', '""') + '"'
    return s


def _encode_table(rows: List[Dict[str, Any]]) -> str:
    # Union of keys, preserving first-seen order.
    cols: List[str] = []
    seen = set()
    for r in rows:
        for k in r.keys():
            if k not in seen:
                seen.add(k)
                cols.append(k)
    lines = ["#table", ",".join(cols)]
    for r in rows:
        lines.append(",".join(_csv_cell(r.get(c)) for c in cols))
    return "\n".join(lines)


def _encode_graph(rows: List[Dict[str, Any]], src: str, tgt: str) -> str:
    # Assign local ids to endpoints in first-seen order.
    ids: Dict[str, int] = {}

    def local_id(name: Any) -> int:
        key = str(name)
        if key not in ids:
            ids[key] = len(ids)
        return ids[key]

    edge_lines: List[str] = []
    attr_cols: List[str] = [k for k in rows[0].keys() if k not in (src, tgt)]
    for r in rows:
        a = local_id(r.get(src))
        b = local_id(r.get(tgt))
        attrs = ",".join(_csv_cell(r.get(c)) for c in attr_cols)
        edge_lines.append(f"{a}>{b}" + (("," + attrs) if attr_cols else ""))

    node_lines = [f"{i} {name}" for name, i in ids.items()]
    out = ["#graph", "#nodes"] + node_lines + ["#edges"]
    if attr_cols:
        out.append("#edge_cols:" + ",".join(attr_cols))
    out += edge_lines
    return "\n".join(out)


def encode(data: Any, mode: Optional[str] = None) -> str:
    """Encode ``data`` compactly per mode; ALWAYS falls back to JSON on doubt.

    Never raises: any unexpected shape or error yields ``json.dumps(data)``.
    """
    resolved = _resolve_mode(mode)
    if resolved == "off":
        return json.dumps(data)
    try:
        if _is_row_list(data):
            if resolved in ("full", "graph"):
                src, tgt = _looks_like_edges(data)
                if src and tgt:
                    return _encode_graph(data, src, tgt)
            return _encode_table(data)
        # Payloads shaped {"nodes": [...], "edges": [...]}
        if (
            resolved in ("full", "graph")
            and isinstance(data, dict)
            and _is_row_list(data.get("edges"))
        ):
            src, tgt = _looks_like_edges(data["edges"])
            if src and tgt:
                return _encode_graph(data["edges"], src, tgt)
        return json.dumps(data)
    except Exception:
        return json.dumps(data)


def encode_with_stats(data: Any, mode: Optional[str] = None) -> Dict[str, Any]:
    """Encode and report token savings vs. JSON (local estimate).

    Returns {encoded, json_tokens, encoded_tokens, saved_pct, mode}.
    """
    resolved = _resolve_mode(mode)
    raw = json.dumps(data)
    encoded = encode(data, mode=mode)
    jt = estimate_tokens(raw)
    et = estimate_tokens(encoded)
    saved = 0.0 if jt == 0 else max(0.0, (jt - et) / jt * 100.0)
    return {
        "encoded": encoded,
        "json_tokens": jt,
        "encoded_tokens": et,
        "saved_pct": round(saved, 1),
        "mode": resolved,
    }
