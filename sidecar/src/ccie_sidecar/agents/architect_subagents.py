"""Vendor subagents for the Network Architect orchestrator.

The Network Architect (engine: deepagents) does not itself bind a vendor tool.
Instead it delegates to one DeepAgents SubAgent per CONFIGURED vendor — each a
specialist with a sandbox bound to just that vendor's helper (plus the global
uml/markmap/wikipedia/rfc helpers). The orchestrator picks a specialist via the
deepagents `task()` tool based on each subagent's `description`.

Skip-unconfigured: a vendor is only turned into a subagent if its credentials
are present (each vendor exposes a `get_<vendor>_config()` that returns None when
unset; pyATS checks for a testbed file; Meraki checks for a resolvable key).
This keeps the orchestrator's delegation menu — and the prompt — short.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
from dataclasses import dataclass
from typing import Any, Callable, List, Optional

from langchain_core.tools import StructuredTool

from ccie_sidecar.agents.deepagents_tools import (
    create_catalog_search_tool,
    create_execute_python_code_tool,
)
from ccie_sidecar.agents.tool_output import (
    TOOL_OUTPUT_GUIDANCE,
    install_tool_output_policy,
)


@dataclass(frozen=True)
class TopolographAgentBinding:
    """Token-private runtime binding for the delegate-only Topolograph agent."""

    base_url: str
    verify_tls: bool
    token: str

    @property
    def usable(self) -> bool:
        return bool(
            isinstance(self.base_url, str)
            and self.base_url.strip()
            and isinstance(self.verify_tls, bool)
            and isinstance(self.token, str)
            and self.token
        )


def coerce_topolograph_binding(value: Any) -> TopolographAgentBinding | None:
    """Accept only an explicitly typed binding; missing plumbing stays disabled."""
    return value if isinstance(value, TopolographAgentBinding) else None


def _cfg(getter_module: str, getter_name: str) -> bool:
    """True if a vendor's get_<vendor>_config() returns a usable config."""
    try:
        mod = __import__(getter_module, fromlist=[getter_name])
        cfg = getattr(mod, getter_name)()
    except Exception:
        return False
    if not cfg:
        return False
    # gNMI config is {"targets": [...]} — needs at least one target.
    if "targets" in cfg:
        return bool(cfg.get("targets"))
    # Most vendors need a host; ThousandEyes is token-only; Secure Endpoint is
    # a cloud API keyed on client_id (no host/token); Juniper Mist is a cloud API
    # keyed on api_token (region picks the host), so accept those credential
    # shapes too. Any of these keys means the integration is usable.
    return bool(
        cfg.get("host")
        or cfg.get("token")
        or cfg.get("client_id")
        or cfg.get("api_token")
        or cfg.get("api_key")
    )


def _pyats_configured() -> bool:
    try:
        from ccie_sidecar.pyats.bridge import default_testbed_path
        return os.path.exists(default_testbed_path())
    except Exception:
        return False


def _meraki_configured() -> bool:
    # Primary: Settings → Meraki writes the key to sessions.db.meraki_config,
    # which the sandbox reads directly (get_meraki_config). Fall back to the
    # legacy encrypted-vault envelope's presence and env vars so pre-existing
    # vault-based setups still light up the specialist.
    try:
        from ccie_sidecar.meraki_config import get_meraki_config
        cfg = get_meraki_config()
        if cfg and cfg.get("api_key"):
            return True
    except Exception:
        pass
    try:
        import sqlite3
        from ccie_sidecar.cml_config import _db_path  # shared sessions.db locator
        db = _db_path()
        if db.exists():
            conn = sqlite3.connect(str(db))
            try:
                cur = conn.cursor()
                cur.execute(
                    "SELECT 1 FROM vault_envelopes WHERE lower(name) LIKE '%meraki%' LIMIT 1"
                )
                if cur.fetchone() is not None:
                    return True
            finally:
                conn.close()
    except Exception:
        pass
    return bool(
        os.environ.get("MERAKI_API_KEY") or os.environ.get("MERAKI_DASHBOARD_API_KEY")
    )


# Each spec: the cli_package id, a human display name, a one-line "delegate to me
# when…" description (what the orchestrator routes on), and a predicate that
# returns True only when that vendor is configured.
VENDOR_SPECS: List[dict] = [
    {
        "id": "aci",
        "display": "Cisco ACI (APIC) fabric",
        "when": "ACI fabric, APIC, tenants, EPGs, bridge domains, VRFs, contracts, "
                "L3Outs, fabric health/inventory, or ACI faults.",
        "configured": lambda: _cfg("ccie_sidecar.aci_config", "get_aci_config"),
    },
    {
        "id": "gnmi",
        "display": "gNMI streaming telemetry / config",
        "when": "reading operational state or config from network devices over "
                "gNMI/gRPC, YANG paths, streaming telemetry, or pushing gNMI config.",
        "configured": lambda: _cfg("ccie_sidecar.gnmi_config", "get_gnmi_config"),
    },
    {
        "id": "fmc",
        "display": "Cisco Secure Firewall (FMC)",
        "when": "firewall policy: access control policies, rules, network/port/host "
                "objects, or managed FTD devices via the FMC.",
        "configured": lambda: _cfg("ccie_sidecar.fmc_config", "get_fmc_config"),
    },
    {
        "id": "thousandeyes",
        "display": "Cisco ThousandEyes",
        "when": "digital-experience monitoring: tests, agents, test results, "
                "hop-by-hop path visualization, reachability, dashboards, or alerts.",
        "configured": lambda: _cfg("ccie_sidecar.thousandeyes_config", "get_thousandeyes_config"),
    },
    {
        "id": "cml",
        "display": "Cisco Modeling Labs (CML)",
        "when": "lab simulation: listing labs, node/topology inspection, or driving "
                "lab lifecycle (start/stop/wipe) in CML.",
        "configured": lambda: _cfg("ccie_sidecar.cml_config", "get_cml_config"),
    },
    {
        "id": "ise",
        "display": "Cisco ISE (identity)",
        "when": "identity and access: network devices, endpoints, authentication/"
                "authorization sessions, policy, or MnT monitoring in ISE.",
        "configured": lambda: _cfg("ccie_sidecar.ise_config", "get_ise_config"),
    },
    {
        "id": "secure_endpoint",
        "display": "Cisco Secure Endpoint (AMP)",
        "when": "endpoint detection & response: protected endpoints/computers, "
                "isolating or un-isolating a host from the network, security events "
                "and detections, endpoint groups/policies, vulnerabilities, or "
                "allow/block file lists in Secure Endpoint (AMP).",
        "configured": lambda: _cfg("ccie_sidecar.secure_endpoint_config", "get_secure_endpoint_config"),
    },
    {
        "id": "cisco_xdr",
        "display": "Cisco XDR (Extended Detection & Response)",
        "when": "extended detection & response: enriching observables/IOCs "
                "(domains, IPs, hashes, emails) for verdicts, judgements & "
                "sightings, XDR incidents and investigations, threat-response "
                "actions, or automation workflows in Cisco XDR.",
        "configured": lambda: _cfg("ccie_sidecar.cisco_xdr_config", "get_cisco_xdr_config"),
    },
    {
        "id": "stealthwatch",
        "display": "Cisco Secure Network Analytics (Stealthwatch)",
        "when": "flow-based security analytics: security events, host/flow "
                "investigation, or alarms in Stealthwatch.",
        "configured": lambda: _cfg("ccie_sidecar.stealthwatch_config", "get_stealthwatch_config"),
    },
    {
        "id": "catalyst_center",
        "display": "Cisco Catalyst Center (DNA Center)",
        "when": "campus/SD-Access fabric: device inventory, network/client health, "
                "sites, or physical topology via Catalyst Center.",
        "configured": lambda: _cfg("ccie_sidecar.catalyst_center_config", "get_catalyst_center_config"),
    },
    {
        "id": "splunk",
        "display": "Cisco Splunk (SIEM / log analytics)",
        "when": "searching logs/events, running SPL queries, listing indexes, saved "
                "searches, or alerts in Splunk for security/operational investigation.",
        "configured": lambda: _cfg("ccie_sidecar.splunk_config", "get_splunk_config"),
    },
    {
        "id": "meraki",
        "display": "Cisco Meraki Dashboard",
        "when": "cloud-managed Meraki: organizations, networks, devices, clients, "
                "or link-layer topology via the Meraki Dashboard API.",
        "configured": _meraki_configured,
    },
    {
        "id": "mist",
        "display": "Juniper Mist",
        "when": "cloud-managed Juniper Mist: orgs, sites, device inventory (APs, "
                "switches, gateways), wireless clients, WLANs, and Assurance/SLE "
                "insights via the Mist REST API.",
        "configured": lambda: _cfg("ccie_sidecar.mist_config", "get_mist_config"),
    },
    {
        "id": "pyats",
        "display": "pyATS (live device CLI)",
        "when": "running show commands or learning state on live devices in the "
                "pyATS testbed (CLI over SSH), when no API exists for the question.",
        "configured": _pyats_configured,
    },
    {
        "id": "grafana",
        "display": "Grafana (observability)",
        "when": "observability dashboards and visualization: searching Grafana "
                "dashboards, listing data sources, checking instance health, "
                "running a PromQL query through a Grafana datasource proxy, or "
                "BUILDING dashboards (create/update/delete panels).",
        "configured": lambda: _cfg("ccie_sidecar.grafana_config", "get_grafana_config"),
    },
    # Unlike credential-only vendors, Zabbix is always exposed to the Architect:
    # the pre-bound client returns a safe Settings → Zabbix instruction until a
    # connection is saved, rather than making the specialist disappear.
    {"id": "zabbix", "display": "Zabbix (monitoring)", "when": "Zabbix hosts, problems, availability, current values, history, trends, templates, inventory, maintenance, or monitoring configuration.", "configured": lambda: True},
    {
        "id": "prometheus",
        "display": "Prometheus (metrics)",
        "when": "time-series metrics: running PromQL instant/range queries, "
                "discovering metric names/metadata, or checking scrape-target "
                "health directly against Prometheus.",
        "configured": lambda: _cfg("ccie_sidecar.prometheus_config", "get_prometheus_config"),
    },
    {
        "id": "netbox",
        "display": "NetBox (DCIM/IPAM source of truth)",
        "when": "the network source of truth: querying or updating device "
                "inventory (DCIM), IP addresses/prefixes/VLANs (IPAM), sites, "
                "racks, or reconciling intent vs. live state in NetBox.",
        "configured": lambda: _cfg("ccie_sidecar.netbox_config", "get_netbox_config"),
    },
    {
        "id": "sketchfab",
        "display": "Sketchfab (3D models)",
        "when": "finding or downloading CC0-licensed 3D models for network "
                "visualization (e.g. real-stencil device models for a Three.js "
                "topology scene).",
        "configured": lambda: True,  # search works anonymously; key is optional
    },
    {
        "id": "devnet",
        "display": "Cisco DevNet content search",
        "when": "looking up Cisco developer documentation: Meraki / Catalyst "
                "Center API docs, operation-id lookup, or general DevNet content "
                "and code examples.",
        "configured": lambda: True,  # public, no credentials
    },
    {
        "id": "fwrule",
        "display": "Firewall rule analyzer (offline)",
        "when": "auditing a firewall/ACL rule set for shadowing, redundancy, "
                "duplicate, or conflicting rules — offline analysis of ACL text "
                "or a normalized rule list, no device connection.",
        "configured": lambda: True,  # offline, no credentials
    },
    {
        "id": "topolograph",
        "display": "Topolograph network graph analysis",
        "when": "Topolograph network graphs, LSDB-derived topology, BGP route analysis, "
                "VRF inventory, LSPs, shortest paths, graph events, or route resolution.",
        # Settings/Vault unlock state is not available to this module yet. The
        # explicit typed binding below is the only path that can enable it.
        "configured": lambda: False,
    },
]


# Explicit trigger words that name a vendor unambiguously. Used to detect which
# platform a question is about so we can (a) nudge the model toward the right
# helper and (b) trim stale prior-turn history when the platform changes. These
# are HIGH-PRECISION aliases (product/brand names), not the fuzzy topic words in
# each spec's `when` — "devices" appears for both Mist and ISE, so it is NOT a
# keyword here. Matched case-insensitively on whole-word boundaries.
VENDOR_KEYWORDS: dict[str, List[str]] = {
    "aci": ["aci", "apic", "epg", "epgs", "bridge domain", "l3out", "l3outs"],
    "gnmi": ["gnmi", "grpc", "yang", "telemetry"],
    "fmc": ["fmc", "firepower", "ftd", "firewall"],
    "thousandeyes": ["thousandeyes", "thousand eyes"],
    "cml": ["cml", "modeling labs", "modeling lab"],
    "ise": ["ise", "identity services engine", "nad", "nads", "radius",
            "tacacs", "posture", "802.1x", "dot1x", "authenticated device",
            "authenticated devices", "auth session", "auth sessions"],
    "secure_endpoint": ["secure endpoint", "amp for endpoints", "amp4e",
                         "isolate", "quarantine"],
    "cisco_xdr": ["xdr", "observable", "observables", "ioc", "iocs", "sighting",
                  "sightings"],
    "stealthwatch": ["stealthwatch", "secure network analytics", "sna"],
    "catalyst_center": ["catalyst center", "dna center", "dnac", "sd-access",
                        "sda"],
    "splunk": ["splunk", "spl", "saved search", "saved searches"],
    "meraki": ["meraki", "dashboard api"],
    "mist": ["mist", "juniper", "wlan", "wlans", "sle", "assurance"],
    "pyats": ["pyats", "testbed", "show command", "show commands"],
    "grafana": ["grafana", "dashboard", "dashboards"],
    "zabbix": ["zabbix", "zabbix server", "zabbix agent"],
    "prometheus": ["prometheus", "promql", "scrape target",
                   "scrape targets", "time series"],
    "netbox": ["netbox", "net box", "dcim", "ipam", "source of truth", "sot"],
    "sketchfab": ["sketchfab", "3d model", "3d models", "stencil"],
    "devnet": ["devnet", "developer.cisco", "operation id", "operation ids"],
    "fwrule": ["fwrule", "acl analysis", "rule shadow", "shadowing",
               "rule conflict", "firewall rule analysis"],
    "topolograph": ["topolograph", "network graph", "lsdb", "lsp", "cspf",
                    "shortest path", "bgp route analysis", "vrf inventory"],
}


# Settings-configurable overrides. A single JSON blob in the app_flags KV table
# (key ccie_vendor_keywords) maps vendor id -> keyword list and REPLACES that
# vendor's built-in list. Read at call time so Settings edits take effect on the
# next agent turn with no restart. Any error -> {} -> built-in defaults.
_VENDOR_KEYWORDS_FLAG_KEY = "ccie_vendor_keywords"

_VALID_VENDOR_IDS = {s["id"] for s in VENDOR_SPECS}


def _db_path():
    """sessions.db path (delegates to feature_flags so both read one location)."""
    from ccie_sidecar.feature_flags import _db_path as _ff_db_path
    return _ff_db_path()


def load_keyword_overrides() -> dict[str, list[str]]:
    """Parse the ccie_vendor_keywords JSON blob from app_flags.

    Returns {vid: [keywords]} for known vendor ids only. {} on any error
    (missing DB/table/row, bad JSON, wrong shape) so routing always degrades
    to the hardcoded VENDOR_KEYWORDS default.
    """
    db = _db_path()
    try:
        if not db.exists():
            return {}
        conn = sqlite3.connect(str(db))
        try:
            cur = conn.cursor()
            cur.execute(
                "SELECT value FROM app_flags WHERE key = ?",
                (_VENDOR_KEYWORDS_FLAG_KEY,),
            )
            row = cur.fetchone()
        finally:
            conn.close()
        if not row or row[0] is None:
            return {}
        parsed = json.loads(row[0])
        if not isinstance(parsed, dict):
            return {}
        out: dict[str, list[str]] = {}
        for vid, kws in parsed.items():
            if vid in _VALID_VENDOR_IDS and isinstance(kws, list):
                cleaned = [str(k).strip().lower() for k in kws if str(k).strip()]
                if cleaned:
                    out[vid] = cleaned
        return out
    except Exception:
        return {}


def effective_keywords() -> dict[str, list[str]]:
    """Built-in VENDOR_KEYWORDS with per-vendor overrides applied (replace)."""
    return {**VENDOR_KEYWORDS, **load_keyword_overrides()}


def _display_for(vid: str) -> str:
    """Human display name for a vendor id (falls back to the id)."""
    spec = next((s for s in VENDOR_SPECS if s["id"] == vid), None)
    return spec["display"] if spec else vid


def keyword_defaults_payload() -> dict:
    """Built-in routing keyword defaults for ALL vendors, in VENDOR_SPECS order.

    Shape: {"vendors": [{"id", "display", "keywords"}, ...]}. Pure static data —
    no DB, no agent. Used by both the `architect.keyword_defaults` RPC and the
    startup file export below.
    """
    return {
        "vendors": [
            {
                "id": s["id"],
                "display": s["display"],
                "keywords": list(VENDOR_KEYWORDS.get(s["id"], [])),
            }
            for s in VENDOR_SPECS
        ]
    }


def vendor_keyword_defaults_path():
    """Path to the exported defaults JSON (same config dir as sessions.db)."""
    return _db_path().parent / "vendor_keyword_defaults.json"


def write_vendor_keyword_defaults_file() -> bool:
    """Export the static defaults to the config dir so the frontend can read them
    WITHOUT a sidecar RPC.

    Why: the sidecar request loop is single-threaded — a long agent turn
    (`agent.react_code_loop`) blocks it, so a quick metadata RPC issued mid-turn
    hangs until the turn finishes. The Settings tab reads this file instead.
    Called at sidecar startup, before the request loop, so the file exists before
    any request (hence before any agent turn) is processed.

    Best-effort: returns True on success, False on any error (the RPC remains a
    fallback for the fresh-startup race before the file lands).
    """
    try:
        path = vendor_keyword_defaults_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(keyword_defaults_payload(), f)
        return True
    except Exception:
        return False


def detect_vendor_ids(text: str, restrict_to: Optional[List[str]] = None) -> List[str]:
    """Vendor ids explicitly named in `text`, in VENDOR_SPECS order.

    Uses whole-word (or phrase-boundary) matching on VENDOR_KEYWORDS so short
    aliases like "ise"/"aci" don't match inside other words ("precise", "basic").
    Only high-precision brand/product terms count — deliberately conservative:
    a miss just means "no nudge / keep history", never a wrong route.

    Args:
        text: the user question to scan.
        restrict_to: if given, only these vendor ids are considered (e.g. the
            currently-configured set), so we never hint at an unconfigured vendor.
    """
    if not text:
        return []
    low = text.lower()
    keywords = effective_keywords()
    found: List[str] = []
    for spec in VENDOR_SPECS:
        vid = spec["id"]
        if restrict_to is not None and vid not in restrict_to:
            continue
        for kw in keywords.get(vid, []):
            # Phrase (has a space) → substring is fine; single token → word boundary.
            if " " in kw:
                if kw in low:
                    found.append(vid)
                    break
            elif re.search(r"(?<![a-z0-9])" + re.escape(kw) + r"(?![a-z0-9])", low):
                found.append(vid)
                break
    return found


def is_blender_request(text: str) -> bool:
    """True when the user is asking about the local Blender scene/tooling."""
    low = (text or "").lower()
    return any(
        token in low
        for token in ("blender", "blendermcp", "bpy", "viewport", "3d scene")
    )


def is_blender_only_request(text: str, configured_ids: List[str]) -> bool:
    """Blender request with no configured network vendor explicitly named."""
    return is_blender_request(text) and not detect_vendor_ids(text, restrict_to=configured_ids)


def blender_routing_hint() -> str:
    return (
        "ROUTING HINT: this question is about local Blender control. Your FIRST "
        "action MUST be execute_python_code using the pre-bound `blender` helper "
        "(for example blender.status(), blender.scene_info(), or "
        "blender.execute_code(...)). Do NOT call search_api_catalog, Meraki, any "
        "vendor API, or task() unless the user explicitly names a network platform."
    )


def architect_routing_hint(user_msg: str, configured_ids: List[str]) -> str:
    """A short system-message nudge naming the platform(s) the question is about.

    Returns "" when no configured vendor is unambiguously named (so we add no
    pressure and let the model decide, as before). This is a THUMB ON THE SCALE,
    not hard routing — the model can still choose otherwise if the words mislead.
    """
    if is_blender_only_request(user_msg, configured_ids):
        return blender_routing_hint()
    hits = detect_vendor_ids(user_msg, restrict_to=configured_ids)
    if not hits:
        return ""
    if len(hits) == 1:
        vid = hits[0]
        if vid in DELEGATE_ONLY_VENDOR_IDS:
            return (
                f"ROUTING HINT: this question names {_display_for(vid)}. Delegate "
                f"to the `{vid}-specialist`; do NOT call it from the shared inline "
                "sandbox or use another vendor."
            )
        return (
            f"ROUTING HINT: this question names {_display_for(vid)}. Call its "
            f"pre-bound `{vid}` helper (or delegate to the `{vid}-specialist`), "
            f"NOT any other vendor. Ignore which platform prior turns used — "
            f"classify THIS question on its own."
        )
    names = ", ".join(f"{_display_for(v)} (`{v}`)" for v in hits)
    return (
        f"ROUTING HINT: this question spans multiple platforms — {names}. Query "
        f"each of those helpers; do not conflate them or reuse a prior turn's vendor."
    )


def scope_history_for_question(
    history: List[dict],
    user_msg: str,
    configured_ids: List[str],
) -> List[dict]:
    """Condense stale prior-turn ANSWERS when the new question switches platform.

    The anchoring bug: the frontend replays the full prior Q&A as chat history,
    so a long previous Mist answer sits in-context right before an ISE question
    and the model re-emits the Mist snippet. When the current question names a
    specific vendor, we replace any prior *assistant* answer that was clearly
    about a DIFFERENT vendor with a one-line stub. User turns are always kept
    verbatim (they're short and carry the real intent); we never drop a turn, so
    genuine follow-ups like "and its ports?" still see the prior context.

    No-op (returns history unchanged) when the current question names no
    configured vendor, so multi-turn context for ambiguous questions is preserved.
    """
    if not history:
        return history
    current = detect_vendor_ids(user_msg, restrict_to=configured_ids)
    if not current:
        return history
    current_set = set(current)
    scoped: List[dict] = []
    for turn in history:
        if not isinstance(turn, dict) or turn.get("role") != "assistant":
            scoped.append(turn)
            continue
        content = turn.get("content") or ""
        prior = set(detect_vendor_ids(content, restrict_to=configured_ids))
        # Keep the answer if it names no vendor (generic) or overlaps the current
        # platform; condense it only when it's about a strictly different vendor.
        if prior and prior.isdisjoint(current_set):
            names = ", ".join(_display_for(v) for v in sorted(prior))
            scoped.append({
                "role": "assistant",
                "content": (
                    f"[Earlier answer about {names} omitted for brevity — it is "
                    f"NOT about the current question. Do not reuse its code or data.]"
                ),
            })
        else:
            scoped.append(turn)
    return scoped


# Vendors that must NOT be flattened into the architect's own inline sandbox.
# (Historically held cisco_xdr to avoid /v1/computers contamination with Secure
# Endpoint, but the XDR_CAPABILITIES_DOC now disambiguates explicitly — "XDR is
# threat-intel, NOT a host inventory; NO /v1/computers" — so XDR runs inline like
# every other vendor, giving the user visible code+results instead of a single
# task() wrapper.) Empty for now; keep the mechanism for any future vendor whose
# surface genuinely can't share one sandbox.
DELEGATE_ONLY_VENDOR_IDS: set[str] = {"topolograph"}


def configured_vendor_ids() -> List[str]:
    """Vendor ids that are currently configured (drives the delegation menu)."""
    return [s["id"] for s in VENDOR_SPECS if _safe(s["configured"])]


def _safe(pred: Callable[[], bool]) -> bool:
    try:
        return bool(pred())
    except Exception:
        return False


def _subagent_system_prompt(spec: dict) -> str:
    """Per-vendor specialist prompt: how to drive that ONE vendor's helper."""
    return (
        f"You are the {spec['display']} specialist.\n\n"
        "MANDATORY FIRST ACTION: your VERY FIRST response MUST call the top-level "
        "`search_api_catalog` tool for the user's exact intent. Do NOT write prose, "
        "import helpers, inspect code, or call `execute_python_code` before discovery. "
        "Use the returned exact record in `execute_python_code`, see the real output, "
        "THEN answer. You have no knowledge of this vendor's live state except "
        "what a tool call returns.\n\n"
        "HARD RULES:\n"
        "1. NEVER claim the vendor is 'not configured', 'unavailable', or that a "
        "key/credential is missing UNLESS an actual tool call returned that exact "
        "error. Saying it without running code first is a hallucination and is "
        "forbidden — run the code and read the result.\n"
        "2. Use the PRE-BOUND client/helper in execute_python_code exactly as documented. "
        "Do NOT re-instantiate clients, do NOT construct new API objects, do NOT "
        "read environment variables or config files, and do NOT use `requests` "
        "directly — the helper is already authenticated for you.\n"
        "3. Call `search_api_catalog` with "
        f"catalog_id={spec['id']!r}; use an exact returned operation or method/path. "
        "Once a usable match appears, STOP searching and make the real call.\n"
        "4. Only own THIS vendor — never attempt another.\n\n"
        "WORKFLOW: write small, focused Python that calls the pre-bound helper, "
        "print() what you find, inspect the printed output, then return a concise "
        "factual answer with the concrete data (names, ids, counts, states). If — "
        "and only if — a tool call returns a genuine 'not configured' / auth "
        "error, report that plainly and name the Settings tab to fix it."
    )


def build_vendor_subagents(
    emit: Optional[Callable[[dict], None]] = None,
    include_unconfigured: bool = False,
    catalogs: Optional[List[dict[str, Any]]] = None,
    topolograph_binding: TopolographAgentBinding | None = None,
) -> List[Any]:
    """Build one DeepAgents SubAgent per configured vendor.

    Args:
        emit: diagram/event callback threaded into each specialist's sandbox.
        include_unconfigured: if True, build a subagent for every vendor
            regardless of config (used by tests). Default False = skip-unconfigured.

    Returns:
        List of `deepagents.SubAgent` specs (one per vendor).
    """
    from deepagents import SubAgent

    if catalogs is None:
        from ccie_sidecar.agents.catalog_grounding import load_catalogs_for_agent

        catalogs = load_catalogs_for_agent("network-architect")
    subagents: List[Any] = []
    for spec in VENDOR_SPECS:
        if spec["id"] == "topolograph":
            continue
        if not include_unconfigured and not _safe(spec["configured"]):
            continue
        tool = create_execute_python_code_tool(
            cli_package=spec["id"],
            vault_secrets={},
            emit_callback=emit or (lambda e: None),
            catalogs=[c for c in catalogs if c.get("id") == spec["id"]],
        )
        tools = [tool]
        catalog_search_tool = create_catalog_search_tool(tool)
        if catalog_search_tool is not None:
            tools.insert(0, catalog_search_tool)
        subagents.append(
            SubAgent(
                name=f"{spec['id']}-specialist",
                description=f"Delegate here for: {spec['when']}",
                system_prompt=_subagent_system_prompt(spec),
                tools=tools,
            )
        )
    topolograph_specialist = build_topolograph_specialist(
        topolograph_binding,
        catalogs=[c for c in catalogs if c.get("id") == "topolograph"],
    )
    if topolograph_specialist is not None:
        subagents.append(topolograph_specialist)
    return subagents


def build_topolograph_specialist(
    binding: TopolographAgentBinding | None,
    *,
    catalogs: Optional[List[dict[str, Any]]] = None,
) -> Any | None:
    """Build a delegate-only specialist with an in-process token closure."""
    if binding is None or not binding.usable:
        return None
    from deepagents import SubAgent
    from ccie_sidecar.agents.catalog_grounding import CatalogIndex
    from ccie_sidecar.topolograph import TopolographClient, TopolographRuntimeConfig

    client = TopolographClient(
        TopolographRuntimeConfig(binding.base_url, binding.verify_tls),
        binding.token,
    )

    def bounded_result(value: Any) -> str:
        safe: dict[str, Any] = {
            "ok": True,
            "summary": "Topolograph operation completed.",
        }
        if isinstance(value, dict):
            for key in (
                "server_name",
                "server_version",
                "vendor",
                "protocol",
            ):
                item = value.get(key)
                if isinstance(item, str):
                    safe[key] = item[:160]
            for key in ("latency_ms", "bytes", "accepted"):
                item = value.get(key)
                if isinstance(item, (int, float, bool)):
                    safe[key] = item
            unexpected = value.get("unexpected_tools")
            if isinstance(unexpected, list) and all(isinstance(item, str) for item in unexpected):
                safe["unexpected_tools"] = [item[:80] for item in unexpected[:50]]
            warnings = value.get("warnings")
            if isinstance(warnings, list):
                safe["warning_count"] = len(warnings)
        return json.dumps(safe, ensure_ascii=False)

    def topolograph_mcp_call(
        operation: str,
        arguments: dict[str, Any] | None = None,
    ) -> str:
        """Call one exact certified Topolograph MCP tool."""
        if operation == "delete_lsp" and not ((arguments or {}).get("lsp_name") or (arguments or {}).get("delete_all") is True):
            raise ValueError("delete_lsp requires lsp_name or delete_all=true")
        return bounded_result(client.call_tool(operation, arguments or {}))

    tool = StructuredTool.from_function(
        func=topolograph_mcp_call,
        name="topolograph_mcp_call",
        description=(
            "Call one exact certified Topolograph MCP tool after searching the "
            "topolograph catalog. Pass matches[*].operation, never the catalog "
            "record name, plus a JSON object of arguments. The helper is "
            "authenticated in-process."
        ),
    )
    object.__setattr__(tool, "_ccie_catalog_index", CatalogIndex(catalogs or []))
    search_tool = create_catalog_search_tool(tool)
    tools = [tool] if search_tool is None else [search_tool, tool]
    return SubAgent(
        name="topolograph-specialist",
        description=(
            "Delegate here for: Topolograph network graphs, LSDB-derived topology, "
            "BGP route analysis, VRF inventory, LSPs, shortest paths, graph events, "
            "or route resolution."
        ),
        system_prompt=(
            "You are the Topolograph specialist. First search the topolograph "
            "catalog for the exact user intent, then call topolograph_mcp_call "
            "with matches[*].operation and its arguments; never pass the catalog "
            "record name. Report only data returned by the live helper. Do not "
            "import clients, inspect config, read environment variables, or use "
            "generic MCP."
        ),
        tools=tools,
    )


def build_architect_direct_tool(
    emit: Optional[Callable[[dict], None]] = None,
    include_unconfigured: bool = False,
    user_msg: str = "",
    catalogs: Optional[List[dict[str, Any]]] = None,
    delegate_only_configured_ids: Optional[set[str]] = None,
) -> tuple[StructuredTool, List[str]]:
    """Build ONE execute_python_code tool whose sandbox binds EVERY configured
    vendor helper at once, so the orchestrator can query any platform directly —
    without the extra round-trips of delegating to a subagent.

    This is the flatten: measured data showed a single-vendor question cost ~5-6
    slow LLM calls (orchestrator delegate -> specialist reason -> tool -> specialist
    synthesize -> orchestrator synthesize). Querying inline collapses that to ~2
    (decide+run, then answer). Subagents remain available (build_vendor_subagents)
    for genuine multi-vendor parallelism.

    Returns (tool, configured_vendor_ids).
    """
    from ccie_sidecar.agents.code_exec import (
        _build_sandbox_globals,
        _execute_code_with_timeout,
        _build_env_overrides,
    )

    # Delegate-only vendors (e.g. cisco_xdr) are deliberately NOT bound inline —
    # they route to their specialist subagent instead, so their catalog never
    # co-mingles with another vendor's in this shared sandbox.
    ids = [
        s["id"] for s in VENDOR_SPECS
        if (include_unconfigured or _safe(s["configured"]))
        and s["id"] not in DELEGATE_ONLY_VENDOR_IDS
    ]

    # Start from a base sandbox (global helpers: uml/markmap/wikipedia/rfc/drawio/
    # proxmox + stdlib), then merge each configured vendor's bindings into it. We
    # call _build_sandbox_globals per vendor and copy the vendor-specific keys
    # over — this reuses every existing install_* (incl. meraki's inline SDK init)
    # with zero duplication.
    sandbox_globals = _build_sandbox_globals(None, {}, emit=emit or (lambda e: None))
    for vid in ids:
        try:
            vg = _build_sandbox_globals(vid, {}, emit=emit or (lambda e: None))
            for k, v in vg.items():
                if k not in sandbox_globals:
                    sandbox_globals[k] = v
        except Exception:
            pass

    if catalogs is None:
        from ccie_sidecar.agents.catalog_grounding import load_catalogs_for_agent

        catalogs = load_catalogs_for_agent("network-architect")
    from ccie_sidecar.agents.catalog_grounding import (
        catalog_prompt_hint,
        install_catalog_grounding,
    )

    catalog_index = install_catalog_grounding(
        sandbox_globals,
        catalogs,
        active_catalog_ids=ids,
    )

    # Meraki SDK env vars (key from Settings) so re-instantiation also works.
    env_overrides = _build_env_overrides({})
    output_policy, tool_output = install_tool_output_policy(
        sandbox_globals,
        sensitive_values=env_overrides.values(),
    )
    def execute_python_code(code: str) -> str:
        result = _execute_code_with_timeout(
            code=code,
            globals_dict=sandbox_globals,
            env_overrides=env_overrides,
            timeout=30,
            label="network-architect",
        )
        return output_policy.format_execution_result(result, tool_output)

    # Keep the parent Architect prompt bounded. Every raw catalog and helper stays
    # in the sandbox, but the model sees only one compact binding line per vendor
    # plus the constant-size api_catalog instruction. Exact endpoint details enter
    # context only when the model searches for them.
    sections: list[str] = []
    for vid in ids:
        spec = next((s for s in VENDOR_SPECS if s["id"] == vid), None)
        title = spec["display"] if spec else vid
        api_helpers = sorted(
            key
            for key, value in sandbox_globals.items()
            if key.endswith("_api_call")
            and callable(value)
            and (key == f"{vid}_api_call" or key.startswith(f"{vid}_"))
        )
        bindings = api_helpers or ([vid] if vid in sandbox_globals else [])
        binding_text = ", ".join(f"`{name}`" for name in bindings) or "pre-bound helper"
        sections.append(
            f"- {title} (`{vid}`): {binding_text}; discover via "
            f"the top-level `search_api_catalog` tool with catalog_id={vid!r}."
        )
    helpers_doc = "\n".join(sections) if sections else "(no vendor platforms configured)"
    catalog_hint = catalog_prompt_hint(catalog_index)

    # Delegate-only vendors are CONFIGURED but deliberately not bound inline (their
    # API surface would contaminate other vendors' in one shared sandbox). The model
    # must still know they exist and are reached via task() — otherwise it wrongly
    # reports them "not configured" instead of delegating to their specialist.
    delegate_only_configured = [
        s for s in VENDOR_SPECS
        if s["id"] in DELEGATE_ONLY_VENDOR_IDS
        and (
            include_unconfigured
            or _safe(s["configured"])
            or s["id"] in (delegate_only_configured_ids or set())
        )
    ]
    delegate_doc = ""
    if delegate_only_configured:
        lines = "\n".join(
            f"- {s['display']} ({s['id']}): delegate to the `{s['id']}-specialist` "
            f"via task() for — {s['when']}"
            for s in delegate_only_configured
        )
        delegate_doc = (
            "\n\nALSO CONFIGURED but NOT in this sandbox — these are reached ONLY by "
            "delegating with task() (do NOT call them here, and do NOT say they are "
            "'not configured'):\n" + lines
        )

    # Memory-first directive PLUS the actual KNOWN FACTS INDEX — both in the tool
    # description (the strong channel, per commit 74e14c8). Previously only the
    # directive ("check your memory") was injected here while the facts index was
    # NOT, so the architect was told to check a memory it could never see. Now the
    # stored org/network ids + topology are shown, so it can skip the live crawl.
    from ccie_sidecar.agents.graph_helper import memory_first_preamble, known_facts_note
    _mem = memory_first_preamble()
    _mem_line = (_mem + "\n\n") if _mem else ""
    _facts = known_facts_note(user_msg) if _mem else ""
    _facts_line = (_facts + "\n\n") if _facts else ""

    # Global helpers (uml/markmap/wikipedia/rfc) are PRE-BOUND sandbox objects,
    # not standalone tools — the model must call them as `markmap.mindmap(...)`
    # inside execute_python_code, never as a top-level tool or via subprocess.
    # Include the full call-signature blurb so it doesn't hallucinate an API and
    # thrash (markmap-cli/write_file/subprocess) until the step limit.
    from ccie_sidecar.agents.code_exec import (
        BLENDER_SANDBOX_BLURB,
        UTILITY_SANDBOX_BLURB,
        SANDBOX_SHAPE_DISCIPLINE_BLURB,
    )

    description = (
        "Execute Python to query ANY configured network platform directly, plus "
        "the local Blender scene via the pre-bound `blender` helper. "
        "Every configured vendor's client is PRE-BOUND in this one sandbox — "
        "call it and print() the result; do NOT re-instantiate clients or use "
        "requests directly.\n\n"
        f"{BLENDER_SANDBOX_BLURB}\n\n"
        f"{UTILITY_SANDBOX_BLURB}\n\n"
        f"{SANDBOX_SHAPE_DISCIPLINE_BLURB}\n\n"
        f"{TOOL_OUTPUT_GUIDANCE}\n\n"
        f"{_mem_line}"
        f"{_facts_line}"
        f"{catalog_hint}\n\n"
        f"CONFIGURED PLATFORMS (compact bindings):\n{helpers_doc}"
        f"{delegate_doc}"
    )

    tool = StructuredTool.from_function(
        func=execute_python_code,
        name="execute_python_code",
        description=description,
    )
    object.__setattr__(tool, "_ccie_catalog_index", catalog_index)
    return tool, ids
