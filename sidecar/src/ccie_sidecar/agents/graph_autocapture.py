"""Deterministic memory WRITE hook for agent API calls.

The context-graph read side (``known_facts_note``) is already automatic, but the
write side historically depended on the LLM voluntarily calling
``graph.remember(...)`` — which it does not do reliably (commit 74e14c8, three
live confirmations). This module closes that loop: it observes API responses as
they flow back through a vendor ``*_api_call`` helper and persists durable
identifiers to ``graph_facts`` IN CODE, with zero LLM cooperation. The existing
read hook then surfaces them on the next run.

Design: intentionally GENERIC, keyed off URL path shape rather than per-vendor
parsers, so the same hook serves meraki/ise/mist/etc. It captures only *durable*
identity facts (org/network ids, device serials, link-layer neighbors) — never
transient/bulk data — and is fully defensive (any failure is a silent no-op;
this must never break an API call).

Enabled only when the context-graph feature is on (``ccie_context_graph``).
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional


def _enabled() -> bool:
    try:
        from ccie_sidecar.feature_flags import context_graph_enabled
        return context_graph_enabled()
    except Exception:
        return False


def _remember(entity: str, key: str, value: str, forever: bool = True) -> None:
    """Persist one durable fact via the graph helper. Silent on any error.

    forever=True pins identity facts (org/network ids, serials) so they are
    exempt from the staleness window — an id doesn't go stale.
    """
    try:
        from ccie_sidecar.agents.graph_helper import GraphHelper
        GraphHelper().record_fact(entity, key, value, forever=forever)
    except Exception:
        pass


# Path patterns → (id-capturing behavior). Kept minimal and vendor-neutral.
_ORG_NETWORKS_RE = re.compile(r"/organizations/([^/]+)/networks", re.I)
_NET_TOPOLOGY_RE = re.compile(r"/networks/([^/]+)/topology/linkLayer", re.I)


def capture(scope: str, method: str, path: str, response: Dict[str, Any]) -> None:
    """Inspect one API response and persist any durable facts it reveals.

    scope    : vendor id (e.g. 'meraki') — namespaces the stored entities.
    method   : HTTP method; only GETs are captured.
    path     : request path (may include the query string).
    response : the parsed helper result, e.g. {"status_code", "data", ...}.
    """
    if not _enabled():
        return
    try:
        if (method or "").upper() != "GET":
            return
        status = response.get("status_code")
        if status is not None and int(status) >= 400:
            return
        data = response.get("data")
        if data is None:
            return
        scope = (scope or "vendor").strip().lower()

        # 1. Organizations list → org name/id map (durable identity).
        if re.search(r"/organizations/?$", path, re.I) and isinstance(data, list):
            for org in data:
                if isinstance(org, dict) and org.get("id") and org.get("name"):
                    ent = f"{scope}:org:{str(org['name']).strip().lower()}"
                    _remember(ent, "org_id", str(org["id"]))

        # 2. Networks in an org → network name/id map.
        elif _ORG_NETWORKS_RE.search(path) and isinstance(data, list):
            for net in data:
                if isinstance(net, dict) and net.get("id") and net.get("name"):
                    ent = f"{scope}:network:{str(net['name']).strip().lower()}"
                    _remember(ent, "network_id", str(net["id"]))

        # 3. Link-layer topology → per-network device inventory + neighbor links.
        elif _NET_TOPOLOGY_RE.search(path) and isinstance(data, dict):
            net_id = _NET_TOPOLOGY_RE.search(path).group(1)
            _capture_topology(scope, net_id, data)
    except Exception:
        return  # a capture failure must never affect the API call


def recall_context_message(user_msg: str, max_entities: int = 8) -> str:
    """Retrieve established knowledge for the entities a question names.

    This is the READ-BEFORE-ANSWER phase (the "second brain" pattern): it runs
    BEFORE the agent executes and returns a plain statement of what we already
    know about the entities the question mentions — to be handed to the agent as
    ESTABLISHED CONTEXT (a conversation turn), NOT as a "you may check this"
    tool directive. The distinction is the whole point: prior work proved the
    agent ignores a directive to check memory (commit 74e14c8), so instead we
    pre-load the facts as knowledge it already has.

    Only entities whose name matches a token in the question are included, so a
    large fact store doesn't flood the turn. Returns "" when the feature is off
    or nothing relevant is known (zero added tokens).
    """
    if not _enabled():
        return ""
    try:
        import re
        tokens = [t for t in re.split(r"[^a-z0-9]+", (user_msg or "").lower()) if len(t) >= 3]
        if not tokens:
            return ""

        from ccie_sidecar.agents.graph_helper import _db_path
        db = _db_path()
        if not db.exists():
            return ""
        import sqlite3
        conn = sqlite3.connect(str(db), timeout=3.0)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT entity, key, value FROM graph_facts "
                "WHERE valid_to IS NULL ORDER BY valid_from DESC"
            ).fetchall()
        finally:
            conn.close()

        # Index rows by entity for lookups + bridging.
        facts_by_entity: "Dict[str, List[Any]]" = {}
        for r in rows:
            facts_by_entity.setdefault(r["entity"], []).append(r)

        # Keep entities whose NAME segment matches a question token. When a
        # network entity matches, also bridge in its topology entity (keyed by
        # network_id, which no question token would match) so "draw example-branch"
        # recalls example-branch's topology, not just its id.
        matched: List[str] = []
        for ent in facts_by_entity:
            name = ent.lower().rsplit(":", 1)[-1]
            if any(t in name for t in tokens):
                matched.append(ent)
                # Bridge: network:<name> -> topology:<network_id>.
                if ":network:" in ent.lower():
                    for r in facts_by_entity[ent]:
                        if r["key"] == "network_id":
                            topo_ent = f"{ent.split(':', 1)[0]}:topology:{str(r['value']).lower()}"
                            if topo_ent in facts_by_entity and topo_ent not in matched:
                                matched.append(topo_ent)

        by_entity: "Dict[str, List[str]]" = {}
        order: List[str] = []
        for ent in matched:
            if len(by_entity) >= max_entities:
                break
            by_entity[ent] = []
            order.append(ent)
            for r in facts_by_entity[ent]:
                val = str(r["value"])
                if len(val) > 600:
                    val = val[:600] + "…"
                by_entity[ent].append(f"    - {r['key']}: {val}")

        if not by_entity:
            return ""
        lines: List[str] = []
        for ent in order:
            lines.append(f"  {ent}:")
            lines.extend(by_entity[ent])
        return (
            "ESTABLISHED CONTEXT (already known from prior sessions — treat these "
            "as facts you have ALREADY retrieved; do not re-fetch them from the "
            "vendor API unless the user asks for a fresher value):\n"
            + "\n".join(lines)
        )
    except Exception:
        return ""


def _wrap_for_capture(vendor: str, fn):
    """Wrap a `{vendor}_api_call` closure so each response feeds ``capture``.

    Idempotent (re-wrap is a no-op) and fully transparent: the wrapper returns
    the underlying result unchanged; capture runs as a side effect and can never
    affect the call. Mirrors api_memo.wrap_api_call's contract.
    """
    if getattr(fn, "_ccie_autocapture", False):
        return fn
    import json as _json

    def wrapped(method, path, body=None, query_params=None, *args, **kwargs):
        result = fn(method, path, body, query_params, *args, **kwargs)
        try:
            parsed = result if isinstance(result, dict) else _json.loads(result)
            if isinstance(parsed, dict):
                capture(vendor, method, path, parsed)
        except Exception:
            pass
        return result

    wrapped._ccie_autocapture = True  # type: ignore[attr-defined]
    return wrapped


def install_autocapture(globals_dict: Dict[str, Any]) -> int:
    """Wrap every bound `*_api_call` global so responses auto-persist durable
    facts to graph_facts — for ALL vendors, at one seam, no per-vendor code.

    Called in _build_sandbox_globals AFTER the vendor install_* calls (and after
    api_memo, so memoized reads are captured too). Vendor name is the global's
    prefix (`meraki_api_call` -> "meraki"). No-op when the flag is off. Returns
    the count wrapped (for tests/logging).
    """
    if not _enabled():
        return 0
    wrapped = 0
    # Zabbix is JSON-RPC: this HTTP-only wrapper supplies path/body/query
    # arguments that do not exist in zabbix_api_call(method, params).
    excluded_helpers = {"zabbix_api_call"}
    for gname, fn in list(globals_dict.items()):
        if gname.endswith("_api_call") and callable(fn) \
                and gname not in excluded_helpers \
                and not getattr(fn, "_ccie_autocapture", False):
            vendor = gname[: -len("_api_call")]
            globals_dict[gname] = _wrap_for_capture(vendor, fn)
            wrapped += 1
    return wrapped


def _capture_topology(scope: str, net_id: str, topo: Dict[str, Any]) -> None:
    """Store the topology as TWO compact facts on the network entity — a device
    inventory and an edge list — rather than one fact per device.

    Storing per-device serial/model facts (dozens of them) floods the recall
    index and crowds out the high-value ids. The whole topology fits in two
    clipped facts the agent can draw from directly, so that's all we keep.
    """
    nodes = topo.get("nodes") or []
    links = topo.get("links") or []

    devices: List[str] = []
    for node in nodes:
        if not isinstance(node, dict):
            continue
        dev = node.get("device") or {}
        name = str(dev.get("name") or "").strip()
        serial = str(dev.get("serial") or "").strip()
        model = str(dev.get("model") or "").strip()
        if name and serial:
            devices.append(f"{name} [{model}] {serial}" if model else f"{name} {serial}")

    edges: List[str] = []
    for link in links:
        if not isinstance(link, dict):
            continue
        ends = link.get("ends") or []
        names = []
        for e in ends:
            d = (e.get("device") or {}) if isinstance(e, dict) else {}
            nm = str(d.get("name") or "").strip()
            if nm:
                names.append(nm)
        if len(names) >= 2:
            edges.append(f"{names[0]} <-> {names[1]}")

    net_ent = f"{scope}:topology:{net_id.lower()}"
    if devices:
        _remember(net_ent, "devices", "; ".join(sorted(set(devices))[:60]))
    if edges:
        _remember(net_ent, "links", "; ".join(sorted(set(edges))[:80]))
