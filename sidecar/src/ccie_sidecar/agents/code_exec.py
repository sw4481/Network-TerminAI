"""
Code execution sandbox for LLM-generated Python code.

Provides a safe execution environment with:
- Standard library modules (json, datetime, collections)
- Data analysis tools (pandas)
- CLI packages (meraki_cli, etc.) initialized with vault secrets
- Safe builtins (print, len, range, etc.)

This sandbox replaces the need to send 933 tool definitions to the LLM.
Instead, the LLM generates Python code that uses these pre-loaded modules.
"""

import json
import datetime
import collections
import os
import signal
import threading
import traceback
from io import StringIO
from contextlib import redirect_stdout
from typing import Any, Callable, Dict, List, Optional


# Tiny prompt addition for sandbox agents. Discovery is on-demand (help/search),
# so no per-capability schemas hit the prompt.
PROXMOX_SANDBOX_BLURB = (
    "A `proxmox` module is available in your Python sandbox for managing Proxmox VE "
    "(VMs, containers, snapshots, backups, ISOs, cluster). Call `proxmox.help()` to list "
    "capabilities and `proxmox.help('<topic>')` for signatures before using one. "
    "Destructive operations require an explicit confirm=True after you confirm intent with the user."
)

# Always-available, no-credential utility helpers injected into every sandbox.
# Tells the model these exist and WHEN to reach for each, so it doesn't try to
# pip-install or hand-roll equivalents.
UTILITY_SANDBOX_BLURB = (
    "General-purpose helpers are ALSO available in your Python sandbox for every "
    "task (no setup needed):\n"
    "- uml: render diagrams via Kroki and preview them inline. Use for UML, "
    "sequence, network, ER, flow, or architecture diagrams. "
    "uml.render(source, diagram_type='plantuml'|'mermaid'|'graphviz'|'c4'|...); "
    "shortcuts uml.plantuml(src)/uml.mermaid(src)/uml.graphviz(src).\n"
    "- markmap: render an interactive mind-map from a markdown outline, previewed "
    "inline. Use to summarize a hierarchy/taxonomy. markmap.mindmap(markdown) or "
    "markmap.from_outline(nested_dict_or_list).\n"
    "- drawio: render draw.io diagrams, previewed inline. Use to visualize a "
    "topology/architecture. drawio.diagram(xml=..., title=...) for mxGraph/draw.io "
    "XML; drawio.from_mermaid(mermaid=..., title=...); drawio.from_csv(csv=..., "
    "title=...). Call it from your code; do NOT print the raw XML.\n"
    "- wikipedia: ground answers in encyclopedic context. "
    "wikipedia.search(q) / wikipedia.summary(title) / wikipedia.page(title).\n"
    "- rfc: look up IETF standards. rfc.get(number) for full text, "
    "rfc.metadata(number), rfc.search(query).\n"
    "- nmap: deep host/service/OS discovery via the native nmap binary. Use to "
    "scan a host or subnet for live hosts, open ports, running services "
    "(product+version), and device/OS type — NOT a vendor _api_call. "
    "nmap.discover_hosts(targets) sweeps a subnet e.g. '192.168.2.0/24'; "
    "nmap.service_scan(targets, ports=None) identifies what's running; "
    "nmap.os_detect(targets)/nmap.deep_scan(targets) classify the device "
    "(privileged — may prompt for admin on macOS). Returns {'ok', 'hosts':[...]}. "
    "Use this for host/port/service discovery instead of any vendor security tool.\n"
    "Prefer these over writing your own HTTP/diagram code. Call `<name>.help()` "
    "for signatures."
)


# Vendor-agnostic discipline for working with API responses whose shape you do
# not already know. This replaces per-API parsing hints: instead of memorizing
# each endpoint's quirks, INSPECT the response, then adapt. Injected into every
# sandbox so it applies to all current and future integrations.
SANDBOX_SHAPE_DISCIPLINE_BLURB = (
    "WORKING WITH UNFAMILIAR API RESPONSES (applies to every helper):\n"
    "- Do NOT assume a response's shape. The same endpoint can return a dict for "
    "one result and a newline-delimited string (ndjson) for many, or wrap rows "
    "under different keys. Before indexing into `data`, INSPECT it once:\n"
    "    print(type(data).__name__, repr(data)[:500])\n"
    "  then write parsing code against what you actually saw.\n"
    "- Probe cheaply first. When unsure of an endpoint's response, make a small "
    "bounded call (e.g. a 1-row limit) purely to learn the shape, then run the "
    "real query knowing how to parse it.\n"
    "- A raised exception is a SHAPE SIGNAL, not a dead end. AttributeError "
    "('str'/'dict' object has no attribute ...), TypeError (string indices must "
    "be integers), or JSONDecodeError (Extra data: line 2 ...) mean the data is "
    "not the type you assumed — print type()/repr() to see the real shape and "
    "adapt in the SAME approach. Do NOT switch endpoints or re-run the identical "
    "assumption; that is thrashing.\n"
    "- Handle both common shapes defensively when a response may vary, e.g.:\n"
    "    rows = ([json.loads(l)['result'] for l in data.splitlines() if l.strip()]\n"
    "            if isinstance(data, str) else data.get('results', [data]))"
)


# Context-graph blurb — only surfaced when CCIE_CONTEXT_GRAPH is enabled (the
# helper is only bound then). Tells the model the `graph` module exists and how
# to reach for it, so it grounds answers in the persisted network graph instead
# of re-discovering topology from scratch.
GRAPH_SANDBOX_BLURB = (
    "A `graph` module persists memory across sessions. Relevant known facts (if "
    "any) are injected automatically as a KNOWN FACTS note — you do not need to "
    "query for them. When a tool reveals a DURABLE, reusable fact, call "
    "graph.remember(entity, key, value) so future questions skip the lookup.\n"
    "MEMORY-FIRST: if an ESTABLISHED CONTEXT block earlier in this conversation "
    "already contains a value the question needs (a resolved id, a device's "
    "serial/model, a network's topology), TREAT IT AS ALREADY RETRIEVED — use it "
    "directly and do NOT make a live/vendor call to re-fetch it. Only call the "
    "API for values that are genuinely missing from context, or when the user "
    "explicitly asks for a fresh/re-checked value.\n"
    "REMEMBER (durable): resolved identifiers (org/network/site ids, device "
    "serials), a device/client role or purpose, software/OS version, a stable "
    "config value, a topology relationship (X connects to Y).\n"
    "Do NOT remember (transient — always re-fetch live): bulk lists or full API "
    "dumps (e.g. an entire /v1/computers or device list), live up/down status, "
    "counts, metrics, or anything that changes minute-to-minute. Storing a bulk "
    "list is wrong — remember one durable fact per entity, not a dump.\n"
    "FOREVER: if the user says to remember something 'forever' / 'permanently' / "
    "'always', pass forever=True — graph.remember(entity, key, value, "
    "forever=True) — so it never expires. A plain remember() expires after the "
    "staleness window. Do NOT call graph functions for questions unrelated to "
    "any stored entity.\n"
    "A `compact` helper cuts token cost 40-60% on large tabular/graph results "
    "(route/interface/BGP peer tables, topology). When a result is a big list of "
    "flat rows, print(compact.encode(result)) instead of the raw JSON; it falls "
    "back to JSON unchanged on non-tabular data, so it is always safe to wrap."
)


def graph_sandbox_blurb_suffix(user_msg: str = "") -> str:
    """Return the graph blurb + auto-injected KNOWN FACTS when the feature is on.

    A suffix (not a bare constant) so callers can append it unconditionally to a
    system prompt without stray separators when the flag is off. Read at
    prompt-assembly time so a Settings toggle takes effect next run with no
    restart. When `user_msg` names an entity we have fresh facts for, those
    facts are appended automatically — the model gets memory for free, with no
    instruction to query and no graph calls on unrelated questions.
    """
    try:
        from ccie_sidecar.feature_flags import context_graph_enabled
        if not context_graph_enabled():
            return ""
        suffix = "\n\n" + GRAPH_SANDBOX_BLURB
        try:
            from ccie_sidecar.agents.graph_helper import known_facts_note
            suffix += known_facts_note(user_msg)
        except Exception:
            pass
        return suffix
    except Exception:
        return ""


class TimeoutException(Exception):
    """Raised when code execution exceeds timeout limit."""
    pass


def _build_sandbox_globals(
    cli_package: Optional[str],
    secrets: Dict[str, Any],
    emit: Optional[Callable[[dict], None]] = None,
) -> Dict[str, Any]:
    """
    Build a global namespace for code execution.

    Allows standard imports and pre-loads common libraries plus a configured
    CLI client (e.g., Meraki Dashboard API) when secrets are provided.

    Args:
        cli_package: Name of CLI package to load (e.g., "meraki"), or None
        secrets: Vault secrets dict (e.g., {"meraki_api_key": "..."})
        emit: Optional event callback (the loop's on_event) so the injected
            ``drawio`` helper can stream diagram events to the frontend.

    Returns:
        Dict mapping variable names to values for exec() globals parameter
    """
    import builtins

    # Use full builtins so `import` statements work in user code.
    globals_dict: Dict[str, Any] = {
        "__builtins__": builtins,
        "json": json,
        "datetime": datetime,
        "collections": collections,
        "os": os,
    }

    # draw.io diagram helper — available to every code-capable agent. Holds the
    # loop's on_event so drawio.diagram(...) streams a diagram event straight to
    # the frontend panel. install_drawio registers it as a global AND an
    # importable module, so both `drawio.diagram(...)` and `import drawio` work.
    try:
        from ccie_sidecar.agents.drawio_helper import install_drawio
        install_drawio(globals_dict, emit=emit)
    except ImportError:
        pass

    # Proxmox VE code-API — available to every sandbox agent (zero-config). Reads
    # connection details from the app config DB. Registers `proxmox` as a global
    # and importable module, mirroring drawio.
    try:
        from ccie_sidecar.proxmox_api.helper import install_proxmox
        install_proxmox(globals_dict, emit=emit)
    except ImportError:
        pass

    # nmap code-API — deep host/service/OS discovery. Auto-detects the nmap
    # binary on PATH; zero-config, always bound. Registers `nmap` as a global and
    # importable module, mirroring proxmox.
    try:
        from ccie_sidecar.nmap_api.helper import install_nmap
        install_nmap(globals_dict, emit=emit)
    except ImportError:
        pass

    # Global utility helpers — available to EVERY agent (no credentials). Each
    # registers a global AND an importable module, mirroring drawio/proxmox.
    #   uml       -> render UML/diagrams via Kroki (previews inline)
    #   markmap   -> render markdown mind-maps (previews inline)
    #   wikipedia -> public Wikipedia lookup
    #   rfc       -> IETF RFC fetch/search
    try:
        from ccie_sidecar.agents.uml_helper import install_uml
        install_uml(globals_dict, emit=emit)
    except ImportError:
        pass
    try:
        from ccie_sidecar.agents.markmap_helper import install_markmap
        install_markmap(globals_dict, emit=emit)
    except ImportError:
        pass
    try:
        from ccie_sidecar.agents.wikipedia_helper import install_wikipedia
        install_wikipedia(globals_dict, emit=emit)
    except ImportError:
        pass
    try:
        from ccie_sidecar.agents.rfc_helper import install_rfc
        install_rfc(globals_dict, emit=emit)
    except ImportError:
        pass

    # Credential-less network helpers — available to EVERY agent (no config, no
    # Settings tab). devnet searches public Cisco developer docs; fwrule analyzes
    # firewall/ACL rule sets offline. Bound unconditionally so the Network
    # Architect always has them (their VENDOR_SPECS `configured` is always True).
    try:
        from ccie_sidecar.devnet import install_devnet
        install_devnet(globals_dict, emit=emit)
    except ImportError:
        pass
    try:
        from ccie_sidecar.fwrule import install_fwrule
        install_fwrule(globals_dict, emit=emit)
    except ImportError:
        pass

    # Context-graph helper — bound for EVERY agent (current and user-created)
    # at this single runtime seam, NOT via per-agent tools.json. Gated by the
    # master CCIE_CONTEXT_GRAPH flag so it is entirely absent when the feature
    # is off (rollback lever). Reads the same sessions.db (no credentials).
    try:
        from ccie_sidecar.feature_flags import context_graph_enabled
        if context_graph_enabled():
            from ccie_sidecar.agents.graph_helper import install_graph
            install_graph(globals_dict, emit=emit)
            # Graph-compact serializer for token-efficient tabular/graph output.
            # Default the encoding to 'graph' when the feature is on unless the
            # operator overrode CCIE_GCF_MODE; still JSON-passthrough on 'off'.
            from ccie_sidecar.agents.compact_helper import install_compact
            _gcf_mode = os.environ.get("CCIE_GCF_MODE", "graph")
            install_compact(globals_dict, emit=emit, default_mode=_gcf_mode)
    except ImportError:
        pass

    # Agent-lessons helper — bound at the same single seam, gated by the
    # independent CCIE_AGENT_LESSONS flag. Exposes `lessons.learn(text)` for
    # explicit capture; entirely absent when the feature is off.
    try:
        from ccie_sidecar.agents.lessons import install_lessons
        install_lessons(globals_dict, scope=cli_package)
    except ImportError:
        pass

    # Pre-import commonly needed libraries
    try:
        import pandas as pd
        globals_dict["pd"] = pd
    except ImportError:
        pass

    try:
        import requests
        globals_dict["requests"] = requests
    except ImportError:
        pass

    # Inject vault secrets as variables (e.g., meraki_api_key) so code
    # can reference them directly without env-var lookups.
    # Also normalize field names (replace spaces/dashes with underscores, lowercase)
    for key, value in secrets.items():
        globals_dict[key] = value  # Original key as-is
        normalized = key.replace(" ", "_").replace("-", "_").lower()
        globals_dict[normalized] = value  # Also add normalized version

    # Bind the Meraki client when this is the meraki agent. Injects the single
    # `meraki_api_call(method, path, ...)` helper (mirrors ise/fmc) instead of
    # the raw ~800-method SDK, so the model uses one reliable pattern instead of
    # guessing method names. install_meraki reads the key from sessions.db
    # (Settings → Meraki) with the same env/vault fallbacks meraki_config uses.
    if cli_package == "meraki":
        try:
            from ccie_sidecar.meraki import install_meraki
            install_meraki(globals_dict, emit=emit)
        except Exception:
            pass

    # Pre-initialize the pyATS client when configured
    if cli_package == "pyats":
        try:
            from ccie_sidecar.pyats.bridge import build_pyats_client
            client = build_pyats_client()
            if client is not None:
                globals_dict["pyats"] = client
        except Exception:
            pass

    # Bind the Stealthwatch client when this is the stealthwatch agent. Reads
    # creds from sessions.db (same as Settings → Stealthwatch) and injects the
    # `stealthwatch_api_call(...)` helper the agent's prompt expects. Without
    # this the sandbox has no such function and the agent calls into the void.
    if cli_package == "stealthwatch":
        try:
            from ccie_sidecar.stealthwatch import install_stealthwatch
            install_stealthwatch(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the ISE client when this is the ise agent. Reads creds from
    # sessions.db (same as Settings → ISE) and injects the `ise_api_call(...)`
    # helper the agent's prompt expects. Without this the sandbox has no such
    # function and the agent calls into the void.
    if cli_package == "ise":
        try:
            from ccie_sidecar.ise import install_ise
            install_ise(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the Secure Endpoint client when this is the secure_endpoint agent.
    # Reads creds from sessions.db (same as Settings → Secure Endpoint) and
    # injects the `secure_endpoint_api_call(...)` helper the agent's prompt expects.
    if cli_package == "secure_endpoint":
        try:
            from ccie_sidecar.secure_endpoint import install_secure_endpoint
            install_secure_endpoint(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the Cisco XDR client when this is the cisco_xdr agent. Reads creds
    # from sessions.db (same as Settings → Cisco XDR) and injects the
    # `cisco_xdr_api_call(...)` helper the agent's prompt expects.
    if cli_package == "cisco_xdr":
        try:
            from ccie_sidecar.cisco_xdr import install_cisco_xdr
            install_cisco_xdr(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the Juniper Mist client when this is the mist agent. Reads creds from
    # sessions.db (same as Settings → Juniper Mist) and injects the
    # `mist_api_call(...)` helper the agent's prompt expects.
    if cli_package == "mist":
        try:
            from ccie_sidecar.mist import install_mist
            install_mist(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the CML client when this is the cml agent. Reads creds from
    # sessions.db (same as Settings → CML) and injects the `cml_api_call(...)`
    # helper the agent's prompt expects.
    if cli_package == "cml":
        try:
            from ccie_sidecar.cml import install_cml
            install_cml(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the Catalyst Center client when this is the catalyst_center agent.
    # Reads creds from sessions.db (same as Settings → Catalyst Center) and
    # injects the `catalyst_center_api_call(...)` helper the agent's prompt expects.
    if cli_package == "catalyst_center":
        try:
            from ccie_sidecar.catalyst_center import install_catalyst_center
            install_catalyst_center(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the ACI (APIC) client when this is the aci agent. Reads creds from
    # sessions.db (same as Settings → ACI) and injects the `aci_api_call(...)`
    # helper the agent's prompt expects.
    if cli_package == "aci":
        try:
            from ccie_sidecar.aci import install_aci
            install_aci(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the gNMI helper when this is the gnmi agent. Reads the target list
    # from sessions.db (same as Settings → gNMI) and injects the `gnmi` object
    # (targets/capabilities/get/subscribe/set) the agent's prompt expects.
    if cli_package == "gnmi":
        try:
            from ccie_sidecar.gnmi import install_gnmi
            install_gnmi(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the FMC client when this is the fmc agent. Reads creds from
    # sessions.db (same as Settings → FMC) and injects the `fmc_api_call(...)`
    # helper the agent's prompt expects.
    if cli_package == "fmc":
        try:
            from ccie_sidecar.fmc import install_fmc
            install_fmc(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the ThousandEyes client when this is the thousandeyes agent. Reads
    # the token from sessions.db (same as Settings → ThousandEyes) and injects
    # the `thousandeyes_api_call(...)` helper the agent's prompt expects.
    if cli_package == "thousandeyes":
        try:
            from ccie_sidecar.thousandeyes import install_thousandeyes
            install_thousandeyes(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the Splunk client when this is the splunk agent. Reads creds from
    # sessions.db (same as Settings → Splunk) and injects the `splunk_api_call(...)`
    # helper the agent's prompt expects.
    if cli_package == "splunk":
        try:
            from ccie_sidecar.splunk import install_splunk
            install_splunk(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the Grafana client when this is the grafana agent. Reads creds from
    # sessions.db (same as Settings → Grafana) and injects the
    # `grafana_api_call(...)` helper the agent's prompt expects.
    if cli_package == "grafana":
        try:
            from ccie_sidecar.grafana import install_grafana
            install_grafana(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the Prometheus client when this is the prometheus agent. Reads creds
    # from sessions.db (same as Settings → Prometheus) and injects the
    # `prometheus_api_call(...)` helper the agent's prompt expects.
    if cli_package == "prometheus":
        try:
            from ccie_sidecar.prometheus import install_prometheus
            install_prometheus(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the NetBox client when this is the netbox agent. Reads creds from
    # sessions.db (same as Settings → NetBox) and injects the
    # `netbox_api_call(...)` helper the agent's prompt expects.
    if cli_package == "netbox":
        try:
            from ccie_sidecar.netbox import install_netbox
            install_netbox(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the Sketchfab client when this is the sketchfab agent. Reads the
    # (optional) key from sessions.db (same as Settings → Sketchfab) and injects
    # the `sketchfab_api_call(...)` helper the agent's prompt expects.
    if cli_package == "sketchfab":
        try:
            from ccie_sidecar.sketchfab import install_sketchfab
            install_sketchfab(globals_dict, emit=emit)
        except Exception:
            pass

    # Bind the IOS-XE translation helper when this is the iosxe_translate agent.
    # Reads YANG models from the local cache + connects to devices via the pyATS
    # testbed; injects the `iosxe` helper (models/schema_tree/cli_to_rpc/
    # validate_native/cli_to_native/native_to_cli) the agent's prompt expects.
    if cli_package == "iosxe_translate":
        try:
            from ccie_sidecar.iosxe_translate import install_iosxe_translate
            install_iosxe_translate(globals_dict, emit=emit)
        except Exception:
            pass

    # IaC agents: block mutating terraform/ansible from code-exec so they can't
    # bypass the iac_apply approval gate. Read-only commands stay allowed. Scoped
    # to "iac" so meraki/pyats sandboxes are unaffected.
    if cli_package == "iac":
        try:
            from ccie_sidecar.agents.iac_subprocess_guard import install_iac_guard
            install_iac_guard(globals_dict)
        except Exception:
            pass

    # In-turn GET de-dup: wrap every bound `*_api_call` global so identical
    # discovery GETs within one turn hit the API once (kills the observed 3x
    # /organizations + /networks re-crawl). Vendor-agnostic, single seam, no
    # vendor-module changes. Gated by the context-graph flag; no-op when off.
    try:
        from ccie_sidecar.feature_flags import context_graph_enabled
        if context_graph_enabled():
            from ccie_sidecar.agents.api_memo import install_api_memo
            install_api_memo(globals_dict)
            # Deterministic memory WRITE hook for EVERY vendor's *_api_call, at
            # the same single seam (after memo, so memoized reads are captured
            # too). Persists durable ids/topology to graph_facts in code, so the
            # read-before-answer phase has something to recall. No-op when off.
            from ccie_sidecar.agents.graph_autocapture import install_autocapture
            install_autocapture(globals_dict)
    except Exception:
        pass

    return globals_dict


def build_history_messages(ctx: Optional[dict], user_msg: str) -> List[Dict[str, Any]]:
    """Build an OpenAI-style message list from prior history + the new turn.

    ctx may carry {"history": [{"role": "user"|"assistant", "content": str}, ...]}
    forwarded from the frontend so the agent has multi-turn context. Only
    user/assistant turns with content are kept; the new user_msg is appended
    last. Used by the legacy code-exec / react-code / react loops.
    """
    messages: List[Dict[str, Any]] = []
    history = (ctx or {}).get("history") or []
    for turn in history:
        if not isinstance(turn, dict):
            continue
        role = turn.get("role")
        content = turn.get("content") or ""
        if role in ("user", "assistant") and content.strip():
            messages.append({"role": role, "content": content})

    # READ-BEFORE-ANSWER: pre-load established knowledge about the entities this
    # question names as a conversation turn, so the agent starts already knowing
    # (e.g.) a network's id/topology instead of being told to look it up. Same
    # phase the deepagents loop runs — kept identical here so memory-first works
    # in the legacy loop too. No-op when the flag is off or nothing is known.
    try:
        from ccie_sidecar.agents.graph_autocapture import recall_context_message
        recalled = recall_context_message(user_msg)
        if recalled:
            messages.append({"role": "user", "content": recalled})
            messages.append({
                "role": "assistant",
                "content": (
                    "Understood — I'll use that established context and only "
                    "query live for anything not already known above."
                ),
            })
    except Exception:
        pass

    messages.append({"role": "user", "content": user_msg})
    return messages


def _build_env_overrides(secrets: Dict[str, Any]) -> Dict[str, str]:
    """
    Map vault secrets to env var names code is likely to look up.

    For each secret, set both the original key (uppercased) and a few
    common aliases (e.g., meraki_api_key -> MERAKI_API_KEY, MERAKI_DASHBOARD_API_KEY).
    """
    env: Dict[str, str] = {}
    for key, value in secrets.items():
        if not isinstance(value, str):
            continue
        # Normalize: replace spaces/dashes with underscores, then uppercase
        normalized = key.replace(" ", "_").replace("-", "_").upper()
        env[normalized] = value
        # Common alias for Meraki SDK
        if normalized == "MERAKI_API_KEY" or "MERAKI" in normalized and "API" in normalized and "KEY" in normalized:
            env.setdefault("MERAKI_API_KEY", value)
            env.setdefault("MERAKI_DASHBOARD_API_KEY", value)

    # Meraki key from Settings (sessions.db) — set the env vars the meraki SDK
    # looks up so the model's code works EVEN IF it re-instantiates
    # `meraki.DashboardAPI()` without api_key= instead of using the pre-bound
    # `meraki` global. Without this the SDK raises "set the
    # MERAKI_DASHBOARD_API_KEY environment variable". Only fills when not already
    # provided via vault secrets above.
    if "MERAKI_API_KEY" not in env:
        try:
            from ccie_sidecar.meraki_config import get_meraki_config
            mcfg = get_meraki_config()
            mkey = (mcfg or {}).get("api_key")
            if mkey:
                env.setdefault("MERAKI_API_KEY", mkey)
                env.setdefault("MERAKI_DASHBOARD_API_KEY", mkey)
        except Exception:
            pass
    return env


def _timeout_handler(signum, frame):
    """Signal handler for SIGALRM timeout."""
    raise TimeoutException("Code execution timed out")


def _execute_code_with_timeout(
    code: str,
    globals_dict: Dict[str, Any],
    timeout: int = 30,
    env_overrides: Optional[Dict[str, str]] = None,
    label: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Execute Python code with timeout protection.

    Args:
        code: Python code string to execute
        globals_dict: Global namespace for execution (from _build_sandbox_globals)
        timeout: Maximum execution time in seconds (default 30)
        env_overrides: Optional env vars to set during execution and restore after
        label: Agent / cli_package context for the execution log (e.g. "meraki").

    Returns:
        Dict with keys:
            - success (bool): True if execution succeeded
            - output (str): Captured stdout
            - error (str): Error message and traceback if failed

    Note on timeouts: SIGALRM only works on the main thread. The legacy
    code_exec_loop runs on the main thread and uses it. DeepAgents runs tools
    on a worker thread, where signal.signal() raises ValueError; in that case
    we fall back to a thread-based watchdog so timeouts still apply.

    Every execution is recorded via exec_log (best-effort) so ALL agent code
    runs are observable from one place, regardless of loop or vendor.
    """
    import time as _time
    start = _time.monotonic()
    # SIGALRM exists only on Unix; on Windows there is no alarm signal at all, so
    # the main-thread path would raise AttributeError. Route Windows (and any
    # non-main thread) to the thread-based watchdog instead.
    if (
        threading.current_thread() is threading.main_thread()
        and hasattr(signal, "SIGALRM")
    ):
        result = _execute_with_sigalrm(code, globals_dict, timeout, env_overrides)
    else:
        result = _execute_in_worker_thread(code, globals_dict, timeout, env_overrides)
    try:
        from ccie_sidecar.exec_log import log_execution
        log_execution(
            label=label,
            code=code,
            result=result,
            duration_ms=int((_time.monotonic() - start) * 1000),
        )
    except Exception:
        pass
    return result


def _run_code_capture(
    code: str,
    globals_dict: Dict[str, Any],
    output_buffer: StringIO,
) -> None:
    """Execute code, redirecting stdout into output_buffer. Raises on error."""
    with redirect_stdout(output_buffer):
        exec(code, globals_dict)


def _apply_env_overrides(
    env_overrides: Optional[Dict[str, str]],
) -> Dict[str, Optional[str]]:
    """Set env overrides, returning the saved originals for later restore."""
    saved_env: Dict[str, Optional[str]] = {}
    if env_overrides:
        for k, v in env_overrides.items():
            saved_env[k] = os.environ.get(k)
            os.environ[k] = v
    return saved_env


def _restore_env(saved_env: Dict[str, Optional[str]]) -> None:
    """Restore env vars captured by _apply_env_overrides."""
    for k, original in saved_env.items():
        if original is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = original


def _execute_with_sigalrm(
    code: str,
    globals_dict: Dict[str, Any],
    timeout: int,
    env_overrides: Optional[Dict[str, str]],
) -> Dict[str, Any]:
    """Main-thread execution path: SIGALRM-based timeout (legacy behavior)."""
    output_buffer = StringIO()
    old_handler = signal.signal(signal.SIGALRM, _timeout_handler)

    saved_env = _apply_env_overrides(env_overrides)

    try:
        signal.alarm(timeout)
        _run_code_capture(code, globals_dict, output_buffer)
        signal.alarm(0)

        return {
            "success": True,
            "output": output_buffer.getvalue(),
            "error": "",
        }

    except TimeoutException:
        signal.alarm(0)
        return {
            "success": False,
            "output": output_buffer.getvalue(),
            "error": f"Code execution timed out after {timeout} seconds",
        }

    except SystemExit as e:
        # Agent-generated code frequently calls sys.exit()/exit()/quit().
        # SystemExit derives from BaseException, NOT Exception, so without this
        # it would propagate out of exec() and KILL THE WHOLE SIDECAR PROCESS.
        # Contain it as an ordinary failed execution.
        signal.alarm(0)
        return {
            "success": False,
            "output": output_buffer.getvalue(),
            "error": f"Code called sys.exit({e.code!r}); treated as end of this "
                     f"execution. Do not call sys.exit()/exit()/quit() in the "
                     f"sandbox — just stop writing code or print your result.",
        }

    except Exception as e:
        signal.alarm(0)
        return {
            "success": False,
            "output": output_buffer.getvalue(),
            "error": f"{type(e).__name__}: {str(e)}\n{traceback.format_exc()}",
        }

    finally:
        signal.signal(signal.SIGALRM, old_handler)
        _restore_env(saved_env)


def _execute_in_worker_thread(
    code: str,
    globals_dict: Dict[str, Any],
    timeout: int,
    env_overrides: Optional[Dict[str, str]],
) -> Dict[str, Any]:
    """Worker-thread execution path (e.g. DeepAgents tool calls).

    SIGALRM is unavailable off the main thread, so run the code in a daemon
    thread and join with the timeout. If it overruns, report a timeout — the
    daemon thread is abandoned (it cannot be force-killed in CPython), which
    matches the best-effort guarantee the sandbox already makes.
    """
    output_buffer = StringIO()
    saved_env = _apply_env_overrides(env_overrides)

    result: Dict[str, Any] = {}

    def _target() -> None:
        try:
            _run_code_capture(code, globals_dict, output_buffer)
            result["success"] = True
            result["error"] = ""
        except SystemExit as e:
            # sys.exit()/exit()/quit() raise SystemExit (a BaseException, NOT an
            # Exception). Uncaught here it would tear down this worker thread and
            # can crash the sidecar. Contain it as a failed execution.
            result["success"] = False
            result["error"] = (
                f"Code called sys.exit({e.code!r}); treated as end of this "
                f"execution. Do not call sys.exit()/exit()/quit() in the sandbox "
                f"— just stop writing code or print your result."
            )
        except Exception as e:  # noqa: BLE001 - surface any user-code error
            result["success"] = False
            result["error"] = f"{type(e).__name__}: {str(e)}\n{traceback.format_exc()}"

    worker = threading.Thread(target=_target, daemon=True)
    try:
        worker.start()
        worker.join(timeout)

        if worker.is_alive():
            return {
                "success": False,
                "output": output_buffer.getvalue(),
                "error": f"Code execution timed out after {timeout} seconds",
            }

        return {
            "success": result.get("success", False),
            "output": output_buffer.getvalue(),
            "error": result.get("error", ""),
        }
    finally:
        _restore_env(saved_env)


# ---------------------------------------------------------------------------
# Main execution engine
# ---------------------------------------------------------------------------

MAX_RETRY_ATTEMPTS = 3


async def code_exec_loop(
    agent_def: dict,
    user_msg: str,
    ctx: dict,
    on_event: Callable[[dict], None],
) -> None:
    """
    Main code execution loop.

    Flow:
    1. Build sandbox with CLI + pandas + stdlib
    2. Define execute_python_code tool (only 1 tool!)
    3. Send to LLM
    4. LLM writes code
    5. Execute with timeout
    6. If error: send to LLM, retry (max 3x)
    7. If success: send output to LLM
    8. LLM formats final answer
    9. Stream events to frontend

    Args:
        agent_def: Agent configuration with attached_tools
        user_msg: User's query
        ctx: Additional context (unused in v1)
        on_event: Callback to emit events to frontend

    Events emitted:
        - code_start: { type: "code_start", code: str }
        - code_executing: { type: "code_executing" }
        - code_result: { type: "code_result", success: bool, output: str }
        - code_error: { type: "code_error", error: str, attempt: int }
        - final: { type: "final", response: str }
        - error: { type: "error", message: str }
    """
    from ccie_sidecar.llm import call_llm

    try:
        # 1. Build sandbox
        # Attached tools are optional - agents can use basic Python sandbox
        # (pandas, json, datetime) without CLI tools
        tool_def = agent_def.get("attached_tools", [{}])[0] if agent_def.get("attached_tools") else {}
        vault_secrets = tool_def.get("vault_secrets", {})
        cli_package = tool_def.get("id", "meraki") if tool_def else None
        sandbox_globals = _build_sandbox_globals(cli_package, vault_secrets, emit=on_event)
        env_overrides = _build_env_overrides(vault_secrets)

        # .env fallback: if vault didn't deliver secrets, load from
        # ~/.ccie-terminal/.env so users have an escape hatch from vault setup.
        env_file_loaded: List[str] = []
        if len(vault_secrets) == 0:
            env_path = os.path.expanduser("~/.ccie-terminal/.env")
            if os.path.exists(env_path):
                try:
                    with open(env_path, encoding="utf-8") as f:
                        for line in f:
                            line = line.strip()
                            if not line or line.startswith("#") or "=" not in line:
                                continue
                            k, _, v = line.partition("=")
                            k = k.strip()
                            v = v.strip().strip('"').strip("'")
                            if k:
                                env_overrides[k] = v
                                env_file_loaded.append(k)
                                # If MERAKI_API_KEY is in .env, mirror to lowercase
                                # so sandbox `meraki_api_key` variable works too, and
                                # bind the single-door meraki_api_call helper on that
                                # key (overriding any Settings-sourced client).
                                if k == "MERAKI_API_KEY":
                                    sandbox_globals["meraki_api_key"] = v
                                    env_overrides.setdefault("MERAKI_DASHBOARD_API_KEY", v)
                                    try:
                                        from ccie_sidecar.meraki import MerakiClient
                                        _c = MerakiClient({"api_key": v})
                                        sandbox_globals["meraki"] = _c
                                        sandbox_globals["meraki_api_call"] = (
                                            lambda method, path, body=None,
                                            query_params=None, paginate=True, _c=_c:
                                            __import__("json").dumps(
                                                _c.call(method, path, body, query_params, paginate))
                                        )
                                    except Exception:
                                        pass
                except Exception as _e:
                    env_file_loaded.append(f"<error: {_e}>")

        # Diagnostic surfaced in stdout of the first exec so it's always visible.
        import sys as _sys
        diag_msg = (
            f"[code_exec] attached_tools count="
            f"{len(agent_def.get('attached_tools') or [])} "
            f"cli_package={cli_package!r} "
            f"vault_secret_keys={list(vault_secrets.keys())} "
            f"env_override_keys={list(env_overrides.keys())} "
            f"env_file_loaded={env_file_loaded}"
        )
        print(diag_msg, file=_sys.stderr, flush=True)

        # 3. Resolve LLM configuration
        from ccie_sidecar.agent import get_saved_config

        config = get_saved_config() or {}
        provider = config.get("provider", "anthropic")
        model = config.get("model", "claude-sonnet-4-6")
        api_key = config.get("api_key") or os.getenv("ANTHROPIC_API_KEY")
        base_url = config.get("base_url")

        # Build description of what's pre-loaded in the sandbox. Memory-first
        # line FIRST (same channel as the vendor "your ONLY way" lines). "" off.
        from ccie_sidecar.agents.graph_helper import memory_first_preamble
        preloaded_lines = []
        _mem = memory_first_preamble()
        if _mem:
            preloaded_lines.append(_mem)
        preloaded_lines += [
            "- json, datetime, collections, os (stdlib)",
            "- pd (pandas)",
            "- requests (HTTP client)",
            "- drawio: render draw.io diagrams. drawio.diagram(xml=..., title=...) "
            "for mxGraph/draw.io XML (previews inline in the app); "
            "drawio.from_mermaid(mermaid=..., title=...); drawio.from_csv(csv=..., title=...). "
            "Each call renders the diagram for the user and returns {url, xml}. "
            "Call it from your code; do NOT print the raw XML.",
        ]
        if cli_package == "meraki":
            preloaded_lines.append(
                "- meraki_api_call(method, path, body=None, query_params=None): "
                "your ONLY way to reach the Cisco Meraki Dashboard (do NOT use "
                "requests or the meraki SDK). Returns a JSON string; json.loads it "
                "-> {'status_code', 'data', 'error', 'blast_radius'}. Paths are "
                "under https://api.meraki.com/api/v1 (omit that prefix). GET lists "
                "are auto-paginated. Find by name first, then query by id: "
                "orgs = json.loads(meraki_api_call('GET','/organizations'))['data']; "
                "nets = json.loads(meraki_api_call('GET', f'/organizations/{org_id}/networks'))['data']; "
                "devices = json.loads(meraki_api_call('GET', f'/networks/{net_id}/devices'))['data']; "
                "one device = json.loads(meraki_api_call('GET', f'/devices/{serial}'))['data']; "
                "clients = json.loads(meraki_api_call('GET', f'/networks/{net_id}/clients', "
                "query_params={'timespan':86400}))['data']; "
                "alerts = json.loads(meraki_api_call('GET', f'/organizations/{org_id}/assurance/alerts'))['data'] "
                "(org-wide; filter items by deviceSerial), or /networks/{net_id}/health/alerts. "
                "ALWAYS fetch real data for device/network detail via GET "
                "/devices/{serial} — NEVER describe a model's specs from memory. "
                "If a path 404s, call meraki.help() for the correct one instead of guessing."
            )
        if cli_package == "stealthwatch":
            preloaded_lines.append(
                "- stealthwatch_api_call(method, path, body=None, query_params=None): "
                "your ONLY way to reach Stealthwatch (do NOT use requests or proxmox). "
                "Returns a JSON string; json.loads it -> "
                "{'status_code', 'data', 'error', 'blast_radius'}. "
                "STEP 1 ALWAYS get the tenant id: "
                "json.loads(stealthwatch_api_call('GET','/sw-reporting/v1/tenants'))"
                "['data']['data'][0]['id'], then use it in every subsequent path."
            )
        if cli_package == "ise":
            preloaded_lines.append(
                "- ise_api_call(method, path, body=None, query_params=None, base=None): "
                "your ONLY way to reach Cisco ISE (do NOT use requests). "
                "Returns a JSON string; json.loads it -> "
                "{'status_code', 'data', 'error', 'blast_radius'}. "
                "The surface/port is inferred from the path: /ers/...=ERS:9060, "
                "/api/...=OpenAPI:443, /admin/API/mnt/...=MnT:443 (read-only). "
                "ERS lists wrap rows under data['SearchResult']['resources']; page "
                "with query_params={'size':100}. Example: "
                "json.loads(ise_api_call('GET','/ers/config/networkdevice'))."
            )
        if vault_secrets:
            secret_names = ", ".join(vault_secrets.keys())
            preloaded_lines.append(
                f"- Vault secrets as variables: {secret_names}"
            )
        if env_overrides:
            env_names = ", ".join(sorted(env_overrides.keys()))
            preloaded_lines.append(
                f"- Env vars set in os.environ: {env_names} "
                "(use these EXACT names; do not invent shorter aliases)"
            )
        preloaded_lines.append(
            "Standard `import` statements work for any installed package."
        )
        preloaded = "\n".join(preloaded_lines)

        # Categorized API method index + discovery hint so the model picks the
        # right method instead of guessing from the handful of examples above.
        from ccie_sidecar.agents.sandbox_index import (
            build_method_index,
            build_discovery_hint,
        )
        method_index = build_method_index(cli_package, sandbox_globals)
        discovery_hint = build_discovery_hint(cli_package)

        tool_description = (
            "Execute Python code to answer questions. "
            "Use for calculations, data analysis, or to query infrastructure. "
            "Only print() output is visible to you.\n\n"
            f"Pre-loaded in the sandbox:\n{preloaded}"
        )
        if discovery_hint:
            tool_description += f"\n\n{discovery_hint}"
        if method_index:
            tool_description += f"\n\n{method_index}"
        code_param_description = "Python code to execute. Use print() to return results."

        if provider == "anthropic":
            # Anthropic native format
            execute_code_tool = {
                "name": "execute_python_code",
                "description": tool_description,
                "input_schema": {
                    "type": "object",
                    "properties": {
                        "code": {
                            "type": "string",
                            "description": code_param_description,
                        }
                    },
                    "required": ["code"],
                },
            }
        else:
            # OpenAI/vLLM format (also used by Google Gemini in OpenAI mode)
            execute_code_tool = {
                "type": "function",
                "function": {
                    "name": "execute_python_code",
                    "description": tool_description,
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "code": {
                                "type": "string",
                                "description": code_param_description,
                            }
                        },
                        "required": ["code"],
                    },
                },
            }

        # Allow agent model_override
        if agent_def.get("model_override"):
            override = agent_def["model_override"]
            if isinstance(override, dict) and override.get("model"):
                model = override["model"]

        # 4. Initialize conversation (prepend prior history for multi-turn context)
        messages: List[Dict[str, Any]] = build_history_messages(ctx, user_msg)

        # 5. LLM loop with retry
        for attempt in range(1, MAX_RETRY_ATTEMPTS + 1):
            # Call LLM with single tool
            response = await call_llm(
                provider=provider,
                model=model,
                messages=messages,
                tools=[execute_code_tool],
                system_prompt=agent_def.get("system_prompt", ""),
                api_key=api_key,
                base_url=base_url,
            )

            # Handle LLM errors
            if response.get("stop_reason") == "error":
                on_event({
                    "type": "error",
                    "message": f"LLM error: {response.get('error', 'Unknown')}",
                })
                return

            # If LLM responded with text only (no tool call)
            if response.get("stop_reason") == "end_turn":
                text_blocks = [
                    b for b in response.get("content", [])
                    if b.get("type") == "text"
                ]
                final_text = text_blocks[0].get("text", "") if text_blocks else ""
                on_event({"type": "final", "response": final_text})
                return

            # Extract tool call
            tool_calls = [
                block for block in response.get("content", [])
                if block.get("type") == "tool_use"
            ]

            if not tool_calls:
                on_event({
                    "type": "error",
                    "message": "LLM did not call execute_python_code",
                })
                return

            # Get code from tool call
            code = tool_calls[0].get("input", {}).get("code", "")
            tool_use_id = tool_calls[0].get("id")

            # Emit code_start
            on_event({"type": "code_start", "code": code})

            # Execute code
            on_event({"type": "code_executing"})
            result = _execute_code_with_timeout(
                code, sandbox_globals.copy(), timeout=30, env_overrides=env_overrides,
                label=cli_package or "code_exec",
            )

            # Check result
            if result["success"]:
                # Success! Send output back to LLM for final formatting
                on_event({
                    "type": "code_result",
                    "success": True,
                    "output": result["output"],
                })

                # Add tool result to conversation in provider-appropriate format
                if provider == "anthropic":
                    messages.append({
                        "role": "assistant",
                        "content": response["content"],  # Include tool_use block
                    })
                    messages.append({
                        "role": "user",
                        "content": [{
                            "type": "tool_result",
                            "tool_use_id": tool_use_id,
                            "content": result["output"],
                        }],
                    })
                else:
                    # OpenAI/vLLM format: assistant message with tool_calls, separate tool message
                    import json as _json
                    messages.append({
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": tool_use_id,
                            "type": "function",
                            "function": {
                                "name": "execute_python_code",
                                "arguments": _json.dumps({"code": code}),
                            },
                        }],
                    })
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_use_id,
                        "content": result["output"],
                    })

                # Get final response from LLM (pass tools so API can validate tool_use/tool_result blocks)
                final_response = await call_llm(
                    provider=provider,
                    model=model,
                    messages=messages,
                    tools=[execute_code_tool],
                    system_prompt=agent_def.get("system_prompt", ""),
                    api_key=api_key,
                    base_url=base_url,
                )

                text_blocks = [
                    b for b in final_response.get("content", [])
                    if b.get("type") == "text"
                ]
                final_text = text_blocks[0].get("text", "") if text_blocks else ""
                on_event({"type": "final", "response": final_text})
                return

            else:
                # Error - retry if attempts remain
                on_event({
                    "type": "code_error",
                    "error": result["error"],
                    "attempt": attempt,
                })

                if attempt < MAX_RETRY_ATTEMPTS:
                    # Ask LLM to fix code in provider-appropriate format
                    error_content = (
                        f"Error (attempt {attempt}/{MAX_RETRY_ATTEMPTS}):\n"
                        f"{result['error']}\n\n"
                        "Please fix the code and try again."
                    )
                    if provider == "anthropic":
                        messages.append({
                            "role": "assistant",
                            "content": response["content"],
                        })
                        messages.append({
                            "role": "user",
                            "content": [{
                                "type": "tool_result",
                                "tool_use_id": tool_use_id,
                                "content": error_content,
                                "is_error": True,
                            }],
                        })
                    else:
                        # OpenAI/vLLM format
                        import json as _json
                        messages.append({
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [{
                                "id": tool_use_id,
                                "type": "function",
                                "function": {
                                    "name": "execute_python_code",
                                    "arguments": _json.dumps({"code": code}),
                                },
                            }],
                        })
                        messages.append({
                            "role": "tool",
                            "tool_call_id": tool_use_id,
                            "content": error_content,
                        })
                    # Loop continues to retry
                else:
                    # Max retries exceeded
                    on_event({
                        "type": "error",
                        "message": (
                            f"Code execution failed after {MAX_RETRY_ATTEMPTS} attempts"
                        ),
                    })
                    return

    except Exception as e:
        on_event({
            "type": "error",
            "message": f"Code execution loop error: {str(e)}",
        })
