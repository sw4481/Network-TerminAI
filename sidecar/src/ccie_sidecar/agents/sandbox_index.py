"""Shared API method-index + discovery hints for code-exec sandboxes.

The code-exec sandbox deliberately does NOT send full tool schemas to the model
(that was ~933 definitions for Meraki). The trade-off was that the model only
ever saw a handful of hardcoded example methods, so weaker/local models would
guess wrong — e.g. listing devices when asked for *switch access policies*
because ``getNetworkDevices`` was one of the few methods it knew existed.

This module restores discoverability cheaply: it introspects the live client
object already injected into the sandbox and emits a categorized index of method
*names* (no schemas — names cost ~1/10th the tokens of full definitions) plus a
discovery instruction telling the model to introspect before guessing.

Used by all three code-exec paths (deepagents_tools, react_code, code_exec) so
they stay consistent. Generated from the live client, so it tracks the installed
SDK version automatically.

Scope:
- meraki: full grouped index of the DashboardAPI sections/methods.
- pyats: the available verb names (client.call("<verb>")).
- drawio / no CLI: nothing — the drawio helper is already fully documented in
  the tool description, and a bare Python sandbox has no API surface to index.
"""
from __future__ import annotations

from typing import Any


def _meraki_index(client: Any) -> str:
    """Build a categorized index of Meraki SDK methods from the live client.

    Loads method descriptions from tools.json so the LLM can see what each method
    does, not just its name. This is critical for vague prompts like "check health"
    where the LLM needs to know which methods return health data.

    To keep token counts manageable (~10-15K instead of ~22K), prioritize showing:
    1. ALL read-only GET methods (monitoring, health, status checks)
    2. Common write methods (create/update/delete for core resources)
    3. Compact name-only list for less-common write methods

    This gives the LLM full visibility into "what data can I query" while keeping
    the context footprint reasonable.
    """
    # Load tools.json to get method descriptions and blast_radius
    import json
    from pathlib import Path

    tools_map: dict[str, dict] = {}  # sdk_method -> {description, blast_radius}
    try:
        tools_path = Path.home() / ".ccie-terminal" / "agents" / "meraki" / "tools.json"
        if tools_path.exists():
            with open(tools_path, encoding="utf-8") as f:
                tools = json.load(f)
            for tool in tools:
                sdk_method = tool.get("sdk_method")
                if sdk_method:
                    tools_map[sdk_method] = {
                        "description": tool.get("description", ""),
                        "blast_radius": tool.get("blast_radius", "unknown"),
                    }
    except Exception:  # noqa: BLE001
        # If tools.json can't be loaded, fall back to name-only index
        pass

    sections = [
        s for s in dir(client)
        if not s.startswith("_") and s and s[0].islower()
    ]
    lines: list[str] = []
    for sec in sections:
        try:
            obj = getattr(client, sec)
        except Exception:  # noqa: BLE001
            continue
        # Only treat it as an API section if it exposes lowerCamel methods.
        methods = [
            m for m in dir(obj)
            if not m.startswith("_") and m and m[0].islower() and callable(getattr(obj, m, None))
        ]
        if not methods:
            continue

        if tools_map:
            # Prioritize showing descriptions for read-only GET methods (monitoring)
            # and common write methods. Less-common writes shown name-only to save tokens.
            section_lines_detailed = []
            section_lines_compact = []

            for method in methods:
                tool_info = tools_map.get(method)
                if not tool_info:
                    # No metadata, just show name
                    section_lines_compact.append(method)
                    continue

                desc = tool_info["description"]
                blast = tool_info["blast_radius"]

                # Show full description for:
                # 1. All GET methods (blast_radius "none" or "low")
                # 2. Common write operations (create/update/delete for devices, networks, orgs)
                is_read_only = blast in ("none", "low")
                is_common_write = any(
                    keyword in method.lower()
                    for keyword in ["device", "network", "organization", "client", "alert", "vlan"]
                )

                if is_read_only or is_common_write:
                    section_lines_detailed.append(f"    {method}: {desc}")
                else:
                    # Less common write method - show name only
                    section_lines_compact.append(method)

            # Emit section header + detailed methods + compact methods
            lines.append(f"  meraki.{sec}:")
            lines.extend(section_lines_detailed)
            if section_lines_compact:
                lines.append(f"    Also: {', '.join(section_lines_compact)}")
        else:
            # No tools.json available, use compact format for all
            lines.append(f"  meraki.{sec}: " + ", ".join(methods))

    if not lines:
        return ""
    return (
        "Meraki SDK method index (call as meraki.<section>.<method>(...)). "
        "Match the user's request to the right method name BEFORE writing code — "
        "do NOT substitute a vaguely-related method (e.g. listing devices when "
        "asked for access policies).\n"
        + _MERAKI_DISAMBIGUATION
        + "\n"
        + "\n".join(lines)
    )


# Common method-name confusions, spelled out so the model picks correctly.
# These are unrelated features that all superficially match "policy"/"vlan".
_MERAKI_DISAMBIGUATION = (
    "IMPORTANT method distinctions:\n"
    "- SWITCH ACCESS POLICIES (802.1X/MAC-auth/RADIUS port authentication; "
    "named policies like 'MAB-Only', 'OpenMode', 'Cisco ISE'; fields "
    "radiusServers/hostMode/guestVlanId/dot1x): use "
    "meraki.switch.getNetworkSwitchAccessPolicies / "
    "getNetworkSwitchAccessPolicy / updateNetworkSwitchAccessPolicy.\n"
    "- GROUP POLICIES (per-client traffic profiles: bandwidth, firewall, VLAN "
    "tagging, content filtering): use meraki.networks.getNetworkGroupPolicies / "
    "getNetworkGroupPolicy / updateNetworkGroupPolicy. These are NOT switch port "
    "authentication — do not use them for access-policy requests.\n"
    "- updateNetworkSwitchAccessPolicy takes accessPolicyNumber (not policyNumber) "
    "and only writable fields (e.g. guestVlanId); maxSessions is read-only.\n"
)


def _pyats_index() -> str:
    """List available pyATS verbs (called as pyats.call("<verb>", ...))."""
    try:
        import pkgutil
        import terminai_pyats.verbs as verbs_pkg
    except Exception:  # noqa: BLE001
        return ""
    verbs = sorted(
        name.replace("_", "-")
        for _, name, _ in pkgutil.iter_modules(verbs_pkg.__path__)
        if not name.startswith("_")
    )
    if not verbs:
        return ""
    return (
        "pyATS verb index (call as pyats.call(\"<verb>\", **kwargs), kebab-case). "
        "Pick the verb that matches the request before writing code:\n  "
        + ", ".join(verbs)
    )


def build_method_index(cli_package: str | None, sandbox_globals: dict[str, Any]) -> str:
    """Return a categorized method/verb index for the configured CLI package.

    Args:
        cli_package: "meraki", "pyats", or other/None.
        sandbox_globals: The built sandbox namespace (holds the live client).

    Returns:
        A multi-line index string, or "" when there is no API surface to index
        (e.g. drawio-only or a bare Python sandbox).
    """
    if cli_package == "meraki":
        client = sandbox_globals.get("meraki")
        # Only index a real, initialized client (has API sections).
        if client is not None and hasattr(client, "organizations"):
            return _meraki_index(client)
        return ""
    if cli_package == "pyats":
        return _pyats_index()
    return ""


def build_discovery_hint(cli_package: str | None) -> str:
    """Return a short instruction telling the model how to discover methods.

    Complements the index: even with names listed, the model should verify exact
    signatures via introspection rather than inventing parameters.
    """
    if cli_package == "meraki":
        return (
            "Endpoint discovery: reach Meraki ONLY through "
            "meraki_api_call(method, path, ...) (json.loads the result; data under "
            "['data']). Paths mirror the Meraki v1 REST API under "
            "https://api.meraki.com/api/v1. Look up by name, then by id: "
            "GET /organizations -> /organizations/{org_id}/networks -> "
            "/networks/{net_id}/devices -> /devices/{serial}. Do NOT use the "
            "meraki SDK object or raw requests."
        )
    if cli_package == "pyats":
        return (
            "Verb discovery: the `pyats` object dispatches via "
            "pyats.call(\"<verb>\", **kwargs). If unsure, run "
            "pyats.call(\"list-devices\") to see the testbed, and prefer a verb "
            "from the index above over raw code. NOTE: list-devices returns "
            "env['data'] as a LIST OF DICTS [{'name','os','type'}, ...], NOT "
            "name strings — extract names with [d['name'] for d in env['data']] "
            "and pass a NAME string as device=... ; never use a device dict as a "
            "dict key or set member (raises 'unhashable type: dict')."
        )
    if cli_package == "stealthwatch":
        return (
            "Endpoint discovery: the embedded API catalog in the "
            "stealthwatch_api_call tool description lists every supported path and "
            "its exact request shape — READ IT, do not guess endpoint names. Key "
            "facts: every data path is /sw-reporting/v1/tenants/{tenantId}/...; "
            "get tenantId first via GET /sw-reporting/v1/tenants. Security-events "
            "and flows are ASYNC: POST .../security-events/queries (filter keys "
            "ONLY: timeRange/alarmCategoryId/hosts/securityEventTypeIds), then GET "
            ".../security-events/results/{queryId} and poll until results are "
            "populated. For recent security events just call the ready-made helper "
            "stealthwatch_security_events(hours=3). If a path 404s it is the wrong "
            "SHAPE — switch to the query/poll pattern, do NOT brute-force names."
        )
    if cli_package == "ise":
        return (
            "Endpoint discovery: the embedded API catalog in the ise_api_call tool "
            "description lists every supported path and its request shape — READ IT, "
            "do not guess. Key facts: three surfaces, port inferred from path prefix "
            "(/ers/...=ERS:9060 config, /api/...=OpenAPI:443 config, "
            "/admin/API/mnt/...=MnT:443 read-only monitoring, serves XML that is "
            "auto-parsed to a nested dict). ERS list responses "
            "wrap rows under data['SearchResult']['resources'] (each a stub with id/"
            "name/link — GET by id for detail); page with query_params {'size':100,"
            "'page':n} and filter with {'filter':'name.CONTAINS.x'}. Do NOT invent "
            "other query keys. ERS must be enabled on the node (Admin → System → "
            "Settings → API Settings)."
        )
    if cli_package == "cml":
        return (
            "Endpoint discovery: the embedded API catalog in the cml_api_call tool "
            "description lists every supported path and its request shape — READ IT, "
            "do not guess. Key facts: ONE base URL (https://<host>/api/v0); auth (Bearer "
            "JWT) is handled for you, do NOT call /authenticate. Labs are the core "
            "resource: GET /labs lists lab IDs, GET /labs/{id}/topology returns the full "
            "node+link graph, GET /labs/{id}/state returns run state, and PUT "
            "/labs/{id}/start|stop|wipe drive lifecycle. GET /nodes lists running nodes "
            "across all labs. Responses are JSON; check status_code < 400 before trusting "
            "data."
        )
    if cli_package == "catalyst_center":
        return (
            "Endpoint discovery: the embedded API catalog in the "
            "catalyst_center_api_call tool description lists every supported path and "
            "its request shape — READ IT, do not guess. Key facts: pass the FULL path "
            "from the host root; auth (Basic -> token -> X-Auth-Token header) is "
            "handled for you, do NOT call the auth/token endpoint. Bases: "
            "/dna/intent/api/v1 (most resources), /dna/intent/api/v2, "
            "/dna/system/api/v1. List rows are wrapped under data['response']; page "
            "with query_params {'offset':1,'limit':500} (offset is 1-based). Core "
            "resources: GET /dna/intent/api/v1/network-device lists devices, "
            "/network-health and /client-health give health, /site lists sites, "
            "/topology/physical-topology returns the graph. Many POST/PUT calls are "
            "ASYNC and return a taskId under data['response']['taskId'] — poll GET "
            "/dna/intent/api/v1/task/{taskId}. Check status_code < 400 before trusting "
            "data."
        )
    if cli_package == "gnmi":
        return (
            "gNMI is multi-target gRPC (via pygnmi), not REST. The `gnmi` helper "
            "addresses devices BY NAME from the configured list — call "
            "gnmi.targets() FIRST. Read-only methods: gnmi.capabilities(name), "
            "gnmi.get(name, paths), gnmi.subscribe(name, paths) (a bounded ONCE "
            "sample; no streaming). Write: gnmi.set(name, update=[(path,value)], "
            "replace=[...], delete=[path]) — mutates live config, blast 'medium'. "
            "YANG paths use origin:path form, e.g. 'openconfig-interfaces:interfaces' "
            "or 'openconfig-interfaces:interfaces/interface[name=Eth1]/state'. Port "
            "defaults: cisco-iosxr/nokia 57400, juniper 32767, arista 6030. Each call "
            "returns {ok, op, data, error, blast_radius}; check ok/error first."
        )
    if cli_package == "fmc":
        return (
            "Endpoint discovery: the embedded API catalog in the fmc_api_call tool "
            "description lists the supported paths and request shapes — READ IT, do "
            "not guess. Key facts: auth (token + default domain) is handled for you, "
            "do NOT call /auth/generatetoken. Config resources live under "
            "/api/fmc_config/v1/domain/{domainUUID}/... — use the LITERAL "
            "'{domainUUID}' and it is auto-filled; platform resources under "
            "/api/fmc_platform/v1/... List responses wrap rows under data['items'] "
            "with data['paging']; page via query_params {'limit':25,'offset':0} and "
            "add {'expanded':True} for full objects. Core: devices/devicerecords "
            "(managed FTDs), policy/accesspolicies (+/{id}/accessrules for rules), "
            "object/networks|hosts|ports. Writes (POST/PUT/DELETE) change firewall "
            "config. Check status_code < 400 before trusting data."
        )
    if cli_package == "thousandeyes":
        return (
            "Endpoint discovery: the embedded API catalog in the "
            "thousandeyes_api_call tool description lists the supported paths — READ "
            "IT, do not guess. Key facts: base https://api.thousandeyes.com; auth "
            "(Bearer token) is handled for you; READ-ONLY (method is always GET). A "
            "configured account group is auto-applied as the 'aid' query param. "
            "Core: GET /v7/tests (find a testId), /v7/agents, "
            "/v7/test-results/{testId}/{testType} (network|http-server|page-load|"
            "dns-server|bgp), /v7/test-results/{testId}/path-vis (hop-by-hop), "
            "/v7/dashboards, /v7/alerts, /v7/account-groups. List responses are an "
            "object keyed by resource name (e.g. data['tests']). Check status_code < "
            "400 before trusting data."
        )
    if cli_package == "aci":
        return (
            "Endpoint discovery: the embedded API catalog in the aci_api_call tool "
            "description lists every supported path and its request shape — READ IT, "
            "do not guess DNs. Key facts: rooted at https://<host>; auth (login "
            "cookie) is handled for you, do NOT call /api/aaaLogin. Two query styles: "
            "CLASS queries (/api/node/class/<moClass>.json) return every object of a "
            "type fabric-wide; MO queries (/api/node/mo/<dn>.json) return one object "
            "by distinguished name. Results are wrapped as data['imdata'] (a list of "
            "{className: {attributes: {...}}}) with data['totalCount']. Refine with "
            "query_params: query-target=subtree, rsp-subtree=children/full, "
            "query-target-filter=eq(fvTenant.name,\"X\"), page/page-size. Core classes: "
            "fvTenant (tenants), fvAEPg (EPGs), fvBD (bridge domains), fvCtx (VRFs), "
            "vzBrCP (contracts), l3extOut (L3Outs), topSystem/fabricNode (inventory), "
            "faultInst (faults). Writes POST an MO tree to its DN path / DELETE remove "
            "it — they hit the live fabric. Check status_code < 400 before trusting "
            "data."
        )
    return ""
