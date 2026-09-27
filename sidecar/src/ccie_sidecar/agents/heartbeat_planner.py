"""Heartbeat Planner: Convert natural language to structured heartbeat check plans.

This agent converts user queries like "Check my Meraki network every 30 minutes"
into structured check plans with agent IDs, prompts, and execution intervals.

Interface:
    plan_heartbeat(nl_input: str, context: dict) -> dict

Returns:
    {
        "status": "success" | "error",
        "plan": {
            "name": str,
            "description": str,
            "interval_minutes": int,
            "checks": [
                {
                    "check_group_name": str,
                    "agent_id": str,
                    "agent_prompt": str,
                    "sort_order": int
                }
            ]
        },
        "error": str | None
    }
"""
from __future__ import annotations

import re
from typing import Any

# Agent keyword mappings - maps keywords to agent IDs
# Keywords should be SPECIFIC to avoid false matches (e.g. "policy" triggers ISE
# even for "access policy" on switches)
AGENT_KEYWORDS = {
    "meraki": ["meraki", "dashboard", "ssid", "meraki network"],
    "pyats": ["pyats", "testbed", "genie", "cisco device health"],
    "stealthwatch": ["stealthwatch", "securex", "netflow", "flow analysis"],
    "ise": ["cisco ise", "identity services", "ise endpoint", "ise policy"],
    "cml": ["cisco cml", "virl", "simulation", "cml lab"],
    "catalyst_center": ["catalyst center", "dna center", "dnac"],
}

# Default interval if not specified
DEFAULT_INTERVAL_MINUTES = 30

# Minimum and maximum intervals
MIN_INTERVAL_MINUTES = 1
MAX_INTERVAL_HOURS = 24 * 7  # 1 week


def extract_interval(text: str) -> int:
    """Extract interval from natural language.

    Recognizes patterns like:
    - "every 5 minutes"
    - "every 2 hours"
    - "every day"
    - "daily"
    - "hourly"

    Returns interval in minutes, or DEFAULT_INTERVAL_MINUTES if not found.
    """
    text_lower = text.lower()

    # Special cases
    if "hourly" in text_lower or "every hour" in text_lower:
        return 60
    if "daily" in text_lower or "every day" in text_lower:
        return 1440  # 24 * 60

    # Pattern: "every X minutes/hours/days"
    pattern = r"every\s+(\d+)\s*(minute|min|hour|hr|day)s?"
    match = re.search(pattern, text_lower)

    if match:
        value = int(match.group(1))
        unit = match.group(2)

        if unit in ("minute", "min"):
            return max(MIN_INTERVAL_MINUTES, value)
        elif unit in ("hour", "hr"):
            return max(MIN_INTERVAL_MINUTES, value * 60)
        elif unit == "day":
            return max(MIN_INTERVAL_MINUTES, value * 1440)

    return DEFAULT_INTERVAL_MINUTES


def _generate_prompt_with_llm(agent_id: str, entities: dict, nl_input: str) -> str:
    """Use an LLM to generate a specific, structured prompt for the agent.

    The LLM knows the agent's API surface and generates prompts with:
    - Exact method/command names to call
    - Parameters and arguments
    - Data extraction instructions
    - Output format requirements
    """
    from ccie_sidecar.agent import get_saved_config
    from ccie_sidecar.providers.langchain_factory import build_chat_model

    # Get configured LLM
    config = get_saved_config()
    if not config:
        raise Exception("No LLM configured in Settings")

    llm = build_chat_model(config)

    # Build agent-specific context about available methods/commands
    agent_context = _get_agent_api_reference(agent_id)

    # Build the meta-prompt
    system_prompt = f"""You are a heartbeat monitoring prompt engineer. Your job is to convert user requests into specific, executable instructions for a {agent_id} monitoring agent.

CRITICAL: Generate SPECIFIC, STRUCTURED prompts that prevent the agent from looping or exploring.

Your output must:
1. Specify the exact catalog search terms and API paths / CLI commands to use
2. Include required parameters (IDs, timespans, filters)
3. Tell the agent WHAT DATA to extract from each call
4. Provide an output FORMAT template (table/list structure)
5. Define COMPLETION CRITERIA (when the agent is done)

{agent_context}

EXAMPLES OF GOOD PROMPTS:

**GOOD (Specific)**:
"For network Example-Branch:
1. Call TOP-LEVEL search_api_catalog once for getOrganizations, getOrganizationNetworks, getOrganizationDevicesStatuses, and getOrganizationAssuranceAlerts.
2. In one execute_python_code block, resolve the exact org and network, then call the returned REST paths with networkIds/networkId filters for Example-Branch.
3. Format: | Category | Count | Details |
Done when: the table contains only Example-Branch live device status and active alerts."

**BAD (Vague)**:
"Check the network health and report any issues"
^ This causes loops! Agent doesn't know which methods to call or when it's done.

OUTPUT FORMAT:
Return ONLY the prompt text. No preamble, no explanation. Just the executable instructions."""

    user_message = f"""User request: "{nl_input}"

Entities detected:
- Networks: {entities.get('networks', [])}
- Testbeds: {entities.get('testbeds', [])}
- Devices: {entities.get('devices', [])}

Generate a specific, structured prompt for the {agent_id} agent that prevents looping."""

    # Call LLM
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_message}
    ]

    response = llm.invoke(messages)
    prompt = response.content.strip()

    return prompt


def _get_agent_api_reference(agent_id: str) -> str:
    """Return a concise API reference for the agent showing available methods."""

    references = {
        "meraki": """
MERAKI CATALOG-GROUNDED REST CONTRACT:
- The raw catalog is not in the prompt. Before API access, call the TOP-LEVEL
  search_api_catalog tool once with catalog_id="meraki" and a query containing
  every exact SDK operation name needed. SDK names are search aliases only;
  never call the SDK directly.
- Then call only exact returned paths through the pre-bound
  meraki_api_call(method, path, query_params=...) helper in one Python block.
- For network health, batch-search: getOrganizations, getOrganizationNetworks,
  getOrganizationDevicesStatuses, getOrganizationAssuranceAlerts.
- Resolve the exact organization and exact network name first.
- Device status must use query_params={"networkIds": [network_id]}.
- Active assurance alerts must use query_params={"networkId": network_id,
  "active": True, "perPage": 100}.
- Never fetch or report other networks for a named-network heartbeat.
- Completion means one concise final answer based on successful live API data;
  if no call succeeds, state that live state is unknown.""",

        "pyats": """
PYATS VERBS (call via pyats.call("<verb>", **kwargs)):
list-devices, device-health, show-command, configure-device, ping, traceroute

Key Verbs for Common Tasks:
- Device inventory: pyats.call('list-devices') → returns list of device names
- Health check: pyats.call('device-health', device='<name>') → returns reachability, memory, cpu
- Show commands: pyats.call('show-command', device='<name>', command='show logging') → returns command output
- Ping test: pyats.call('ping', device='<name>', destination='<ip>') → returns success rate

Common CLI Commands:
- Logs: "show logging | include ERROR|WARN|CRIT"
- Interfaces: "show ip interface brief"
- OSPF: "show ip ospf neighbor"
- BGP: "show ip bgp summary"
- CPU: "show processes cpu"
- Memory: "show memory statistics" """,

        "ise": """
ISE API ENDPOINTS (call via ise_api_call(method, path, ...)):
ERS API (config): /ers/config/networkdevice, /ers/config/endpoint, /ers/config/internaluser
MnT API (monitoring): /admin/API/mnt/Session/ActiveList, /admin/API/mnt/AuthStatus/MACAddress, /admin/API/mnt/FailureReasons

Key Endpoints for Common Tasks:
- Failed auth: /admin/API/mnt/FailureReasons → returns auth failure counts by reason
- Active sessions: /admin/API/mnt/Session/ActiveList → returns {userName, ipAddress, status}
- Endpoints: /ers/config/endpoint?size=100 → returns {name, mac, groupId, portalUser}
- Network devices: /ers/config/networkdevice?size=100 → returns {name, ipAddress, authType}
- Policy violations: Query endpoint profiling status and compliance

Note: ERS responses wrap rows under data['SearchResult']['resources']""",

        "stealthwatch": """
STEALTHWATCH API (call via stealthwatch_api_call(method, path, ...)):
Tenant: /sw-reporting/v1/tenants → get tenant ID (required for all queries)
Alerts: /sw-reporting/v1/tenants/{id}/security-events/queries → POST filter, then GET results
Flows: /sw-reporting/v1/tenants/{id}/flows/queries → POST filter, then GET results
Top hosts: /sw-reporting/v1/tenants/{id}/flows/top-hosts

Key Patterns:
- Always get tenant ID first: GET /sw-reporting/v1/tenants → data['data'][0]['id']
- Security events: POST query with {timeRange, severityId}, then poll results endpoint
- Use helper: stealthwatch_security_events(hours=3) for recent high-severity alerts""",

        "cml": """
CML API (call via cml_api_call(method, path, ...)):
Base: /api/v0
Labs: GET /labs, GET /labs/{id}/topology, PUT /labs/{id}/start, PUT /labs/{id}/stop
Nodes: GET /nodes, GET /nodes/{id}
System: GET /system_information

Key Endpoints:
- Lab list: GET /labs → returns [{id, title, state, node_count}]
- Lab topology: GET /labs/{id}/topology → returns {nodes, links, interfaces}
- Lab state: GET /labs/{id}/state → returns run state
- Start lab: PUT /labs/{id}/start
- Running nodes: GET /nodes → returns nodes across all labs""",

        "catalyst_center": """
CATALYST CENTER API (call via catalyst_center_api_call(method, path, ...)):
Base: /dna/intent/api/v1
Devices: /network-device → device inventory
Health: /network-health, /client-health → health scores
Sites: /site → site hierarchy
Topology: /topology/physical-topology → network graph

Key Endpoints:
- Devices: GET /dna/intent/api/v1/network-device → {hostname, managementIpAddress, reachabilityStatus}
- Health: GET /dna/intent/api/v1/network-health → {healthScore, totalCount, goodCount}
- Issues: GET /dna/intent/api/v1/issues → {issueId, name, severity, status}
- Clients: GET /dna/intent/api/v1/client-health → {scoreDetail}

Note: Many operations are async and return taskId - poll GET /dna/intent/api/v1/task/{id}"""
    }

    return references.get(agent_id, f"# {agent_id.upper()} API\nNo reference available. Generate based on common monitoring patterns.")


def extract_entities(text: str, context: dict) -> dict[str, Any]:
    """Extract network names, testbed names, and other entities from text.

    Args:
        text: Natural language input
        context: Context dict that may contain available networks, testbeds, etc.

    Returns:
        {
            "networks": [str],
            "testbeds": [str],
            "devices": [str],
            "organizations": [str]
        }
    """
    entities = {
        "networks": [],
        "testbeds": [],
        "devices": [],
        "organizations": []
    }

    # Extract quoted strings (explicit entity names)
    quoted = re.findall(r'"([^"]+)"', text)
    quoted.extend(re.findall(r"'([^']+)'", text))

    # Heuristics for entity types based on context
    text_lower = text.lower()

    # If context provides available networks/testbeds, match against them
    if "networks" in context:
        for network in context.get("networks", []):
            if network.lower() in text_lower or network in quoted:
                entities["networks"].append(network)

    if "testbeds" in context:
        for testbed in context.get("testbeds", []):
            if testbed.lower() in text_lower or testbed in quoted:
                entities["testbeds"].append(testbed)

    # Generic extraction from quoted strings if no context available
    if not entities["networks"] and not entities["testbeds"]:
        # Assume quoted strings are network/testbed names
        for q in quoted:
            if any(word in text_lower for word in ["network", "meraki", "wireless"]):
                entities["networks"].append(q)
            elif any(word in text_lower for word in ["testbed", "pyats", "device"]):
                entities["testbeds"].append(q)

    return entities


def identify_agents(text: str) -> list[str]:
    """Identify which agents should be used based on keywords in the text.

    Returns list of agent IDs (e.g., ["meraki", "pyats"]).
    """
    text_lower = text.lower()
    matched_agents = set()

    for agent_id, keywords in AGENT_KEYWORDS.items():
        for keyword in keywords:
            if keyword in text_lower:
                matched_agents.add(agent_id)
                break

    # If no specific agents mentioned, return empty list
    # The caller should handle this (e.g., ask for clarification or default to all)
    return list(matched_agents)


def generate_agent_prompt(agent_id: str, entities: dict, nl_input: str) -> str:
    """Generate a specific prompt for the given agent using an LLM.

    The LLM generates structured, specific prompts that tell the execution agent
    exactly which API methods/commands to call and what data to extract.

    Args:
        agent_id: Agent identifier (e.g., "meraki", "pyats")
        entities: Extracted entities dict
        nl_input: Original natural language input

    Returns:
        Specific prompt string for the agent
    """
    # Try LLM-based generation first
    try:
        return _generate_prompt_with_llm(agent_id, entities, nl_input)
    except Exception as e:
        # Fallback to old keyword-based generators if LLM fails
        print(f"LLM prompt generation failed: {e}, falling back to keyword matching")
        prompts = {
            "meraki": _generate_meraki_prompt,
            "pyats": _generate_pyats_prompt,
            "stealthwatch": _generate_stealthwatch_prompt,
            "ise": _generate_ise_prompt,
            "cml": _generate_cml_prompt,
            "catalyst_center": _generate_catalyst_center_prompt,
        }

        generator = prompts.get(agent_id)
        if generator:
            return generator(entities, nl_input)

        # Last resort fallback
        return f"Check the status and health of {agent_id} resources."


def _generate_meraki_prompt(entities: dict, nl_input: str) -> str:
    """Generate Meraki-specific prompt with explicit API method calls.

    If user requests specific checks (logs, ssid, traffic), generate ONLY those.
    If user requests generic health/monitoring, generate full base template.
    """
    networks = entities.get("networks", [])
    nl_lower = nl_input.lower()

    # Build scope (specific networks or org-wide)
    if networks:
        network_list = ", ".join(f'"{n}"' for n in networks)
        scope_intro = f"For network(s): {network_list}\n\n"
        scope_setup = (
            "   - Call getOrganizations to get org_id\n"
            "   - Call getOrganizationNetworks(org_id) to find network_id for each named network\n"
        )
    else:
        scope_intro = "For the Meraki organization:\n\n"
        scope_setup = "   - Call getOrganizations to get org_id and org name\n"

    # Check for specific requests
    specific_sections = []
    section_num = 1

    if "log" in nl_lower or "event" in nl_lower:
        specific_sections.append(
            f"{section_num}. **Event Log Analysis**:\n"
            f"{scope_setup}"
            "   - Call getNetworkEvents(network_id, per_page=100) or getOrganizationConfigurationChanges(org_id)\n"
            "   - List recent configuration changes, errors, or critical events\n"
            "   - Highlight any connectivity failures or authentication issues\n"
            "   - Report timestamp, event type, and description\n\n"
        )
        section_num += 1

    if "client" in nl_lower and "usage" in nl_lower:
        specific_sections.append(
            f"{section_num}. **Client Usage Details**:\n"
            f"{scope_setup}"
            "   - Call getNetworkClientsApplicationUsage or getNetworkClientsBandwidthUsageHistory\n"
            "   - Report top bandwidth consumers\n"
            "   - Identify any clients with connection issues\n\n"
        )
        section_num += 1

    if "ssid" in nl_lower or "wireless" in nl_lower:
        specific_sections.append(
            f"{section_num}. **Wireless/SSID Status**:\n"
            f"{scope_setup}"
            "   - Call getNetworkWirelessSsids(network_id) for each network\n"
            "   - Report SSID name, enabled/disabled state, auth mode\n"
            "   - Check for any authentication failures or connection drops\n\n"
        )
        section_num += 1

    if "traffic" in nl_lower or "bandwidth" in nl_lower:
        specific_sections.append(
            f"{section_num}. **Traffic Analysis**:\n"
            f"{scope_setup}"
            "   - Call getNetworkTraffic or getOrganizationSummaryTopAppliancesByUtilization\n"
            "   - Report traffic patterns, peak usage times\n"
            "   - Identify any anomalies or spikes\n\n"
        )
        section_num += 1

    # If specific sections requested, return ONLY those
    if specific_sections:
        prompt = scope_intro + "".join(specific_sections)
        prompt += (
            "Format as table:\n"
            "| Item | Details |\n\n"
            "Summary: [Brief summary of findings]"
        )
        return prompt

    # Otherwise, return full base template (generic health check)
    if networks:
        network_list = ", ".join(f'"{n}"' for n in networks)
        only_networks = ", ".join(networks)
        base = (
            f"For network(s): {network_list}\n\n"
            "Generate a live, network-scoped Meraki health report:\n\n"
            "1. **Catalog discovery (exactly once)**:\n"
            '   - Call TOP-LEVEL search_api_catalog with catalog_id="meraki", limit=5, and query "'
            "getOrganizations getOrganizationNetworks getOrganizationDevicesStatuses "
            "getOrganizationAssuranceAlerts\"\n"
            "   - Use the four returned exact GET paths; do not call the SDK or search again\n\n"
            "2. **One live API code block**:\n"
            "   - GET /organizations and resolve the exact organization\n"
            "   - GET /organizations/{org_id}/networks and resolve each exact named network_id\n"
            "   - GET /organizations/{org_id}/devices/statuses with "
            "query_params={\"networkIds\": [network_id]}\n"
            "   - GET /organizations/{org_id}/assurance/alerts with "
            "query_params={\"networkId\": network_id, \"active\": True, \"perPage\": 100}\n"
            "   - Count devices by status and list non-online devices and active alerts\n\n"
            f"3. **Scope**: Report ONLY {only_networks}; never include another network.\n\n"
        )
    else:
        base = (
            "Generate an organization-wide Meraki health report:\n\n"
            "1. **Device Status**:\n"
            "   - Call getOrganizations to get org_id and org name\n"
            "   - Call getOrganizationDevicesStatuses(org_id, total_pages='all')\n"
            "   - Count by status: online, offline, alerting, dormant\n"
            "   - List any offline/alerting devices with network, name, model, status\n\n"
            "2. **Organization Alerts**:\n"
            "   - Call getOrganizationAssuranceAlerts(org_id, per_page=100) for active alerts\n"
            "   - Count total alerts\n"
            "   - Break down by severity (critical, warning, info)\n"
            "   - Sample 5 most recent alerts with type, scope, started_at\n\n"
        )

    base += (
        "Format as table:\n"
        "| Category | Findings |\n"
        "|----------|----------|\n"
        "| ... | ... |\n\n"
        "Overall status: Healthy / Issues Detected"
    )

    return base


def _generate_pyats_prompt(entities: dict, nl_input: str) -> str:
    """Generate pyATS-specific prompt with explicit verb calls.

    If user requests specific checks (logs, cpu, config), generate ONLY those.
    If user requests generic health/monitoring, generate full base template.
    """
    testbeds = entities.get("testbeds", [])
    devices = entities.get("devices", [])

    targets = []
    if testbeds:
        targets.append(f"testbed(s): {', '.join(testbeds)}")
    if devices:
        targets.append(f"device(s): {', '.join(devices)}")

    target_str = " and ".join(targets) if targets else "all configured devices"

    # Detect specific vs. generic request
    nl_lower = nl_input.lower()

    # Check for specific requests
    specific_sections = []
    section_num = 1

    if "log" in nl_lower or "logging" in nl_lower or "syslog" in nl_lower:
        specific_sections.append(
            f"{section_num}. **Log Analysis**:\n"
            "   - Call pyats.call('list-devices') to get device list\n"
            "   - For each device, call pyats.call('show-command', device=<name>, "
            "command='show logging | include ERROR|WARN|CRIT')\n"
            "   - Count critical/error/warning messages per device\n"
            "   - List top 5 most recent critical logs with timestamps\n\n"
        )
        section_num += 1

    if "cpu" in nl_lower or "memory" in nl_lower or "utilization" in nl_lower:
        specific_sections.append(
            f"{section_num}. **Resource Utilization**:\n"
            "   - Call pyats.call('list-devices') to get device list\n"
            "   - For each device:\n"
            "     - Call pyats.call('show-command', device=<name>, command='show processes cpu')\n"
            "     - Call pyats.call('show-command', device=<name>, command='show memory statistics')\n"
            "   - Report CPU % and memory usage per device\n\n"
        )
        section_num += 1

    if "config" in nl_lower or "configuration" in nl_lower:
        specific_sections.append(
            f"{section_num}. **Configuration Check**:\n"
            "   - Call pyats.call('list-devices') to get device list\n"
            "   - Call pyats.call('show-command', device=<name>, command='show running-config')\n"
            "   - Check for any uncommitted changes or misconfigurations\n\n"
        )
        section_num += 1

    # If specific sections requested, return ONLY those
    if specific_sections:
        prompt = f"Run these specific checks on {target_str}:\n\n"
        prompt += "".join(specific_sections)
        prompt += (
            "Format as table:\n"
            "| Device | Findings |\n\n"
            "Summary: [Brief summary of findings]"
        )
        return prompt

    # Otherwise, return full base template (generic health check)
    base_prompt = (
        f"Run comprehensive health checks on {target_str}:\n\n"
        "1. **Device Reachability**:\n"
        "   - Call pyats.call('list-devices') to get testbed inventory\n"
        "   - Call pyats.call('device-health', device=<name>) for each device\n"
        "   - Report: X devices total, Y reachable, Z unreachable\n\n"
        "2. **Interface Status**:\n"
        "   - Call pyats.call('show-command', device=<name>, command='show ip interface brief') "
        "for each reachable device\n"
        "   - Count interfaces: total, up, down\n"
        "   - List any down interfaces\n\n"
        "3. **Protocol Health**:\n"
        "   - Check OSPF: pyats.call('show-command', command='show ip ospf neighbor')\n"
        "   - Check BGP: pyats.call('show-command', command='show ip bgp summary')\n"
        "   - Report neighbor states\n\n"
        "Format as table:\n"
        "| Device | Reachability | Interface Issues | OSPF Neighbors | BGP Peers |\n\n"
        "Overall: Healthy / Issues Detected"
    )

    return base_prompt


def _generate_stealthwatch_prompt(entities: dict, nl_input: str) -> str:
    """Generate Stealthwatch-specific prompt."""
    return (
        "Check Stealthwatch for security concerns. "
        "Report on high-severity alerts, unusual flow patterns, "
        "potential threats, and top talkers."
    )


def _generate_ise_prompt(entities: dict, nl_input: str) -> str:
    """Generate ISE-specific prompt."""
    return (
        "Check Cisco ISE for authentication and policy issues. "
        "Report on failed authentications, endpoint compliance status, "
        "policy violations, and any service health concerns."
    )


def _generate_cml_prompt(entities: dict, nl_input: str) -> str:
    """Generate CML-specific prompt."""
    return (
        "Check Cisco CML lab environments. "
        "Report on lab status, running simulations, "
        "node health, and resource utilization."
    )


def _generate_catalyst_center_prompt(entities: dict, nl_input: str) -> str:
    """Generate Catalyst Center-specific prompt."""
    return (
        "Check Catalyst Center (DNAC) for network assurance issues. "
        "Report on device health, network issues, client connectivity, "
        "and any critical assurance findings."
    )


def _generate_plan_name(nl_input: str, agents: list[str]) -> str:
    """Generate a concise name for the heartbeat plan."""
    # Extract key nouns/phrases
    text_lower = nl_input.lower()

    # Try to find explicit names
    if "check my" in text_lower:
        after_my = text_lower.split("check my", 1)[1]
        # Take first few words
        words = after_my.strip().split()[:3]
        name = " ".join(words)
        if name:
            return name.capitalize()

    # Fallback: use agent names
    if len(agents) == 1:
        return f"{agents[0].replace('_', ' ').title()} Health Check"
    elif len(agents) > 1:
        return "Multi-Agent Health Check"

    return "Network Health Check"


def _generate_description(nl_input: str, agents: list[str], interval: int) -> str:
    """Generate a description for the heartbeat plan."""
    interval_str = _format_interval(interval)
    agent_str = ", ".join(agents) if agents else "network services"

    return f"Monitors {agent_str} {interval_str}. {nl_input}"


def _format_interval(minutes: int) -> str:
    """Format interval for human readability."""
    if minutes < 60:
        return f"every {minutes} minute{'s' if minutes != 1 else ''}"
    elif minutes < 1440:
        hours = minutes // 60
        return f"every {hours} hour{'s' if hours != 1 else ''}"
    else:
        days = minutes // 1440
        return f"every {days} day{'s' if days != 1 else ''}"


def plan_heartbeat(nl_input: str, context: dict | None = None) -> dict[str, Any]:
    """Convert natural language input to a structured heartbeat check plan.

    Args:
        nl_input: Natural language description (e.g., "Check my Meraki network every 30 minutes")
        context: Optional context dict with available networks, testbeds, etc.

    Returns:
        {
            "status": "success" | "error",
            "plan": {...} | None,
            "error": str | None
        }
    """
    if context is None:
        context = {}

    try:
        # Extract components
        interval = extract_interval(nl_input)
        agents = identify_agents(nl_input)
        entities = extract_entities(nl_input, context)

        # Validate
        if not agents:
            return {
                "status": "error",
                "plan": None,
                "error": (
                    "Could not identify which systems to monitor. "
                    "Please mention specific systems like 'Meraki', 'pyATS devices', "
                    "'ISE', 'Stealthwatch', 'CML', or 'Catalyst Center'."
                )
            }

        # Generate checks
        checks = []
        for idx, agent_id in enumerate(sorted(agents)):
            prompt = generate_agent_prompt(agent_id, entities, nl_input)
            checks.append({
                "check_group_name": agent_id.replace("_", " ").title(),
                "agent_id": agent_id,
                "agent_prompt": prompt,
                "sort_order": idx
            })

        # Build plan
        plan = {
            "name": _generate_plan_name(nl_input, agents),
            "description": _generate_description(nl_input, agents, interval),
            "interval_minutes": interval,
            "checks": checks
        }

        return {
            "status": "success",
            "plan": plan,
            "error": None
        }

    except Exception as e:
        return {
            "status": "error",
            "plan": None,
            "error": f"Failed to parse heartbeat plan: {str(e)}"
        }
