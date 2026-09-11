"""Heartbeat Executor: Execute heartbeat checks by running agents.

This module executes heartbeat checks by invoking the appropriate agent
with a given prompt, then parsing the agent's output to extract findings.

Interface:
    execute_check(agent_id: str, prompt: str, check_id: str) -> dict

Returns:
    {
        "findings": [
            {
                "severity": "critical" | "error" | "warning" | "info" | "ok",
                "title": str,
                "message": str,
                "metadata": dict
            }
        ]
    }
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any


# One batch query authorizes the four read-only endpoints needed by the common
# Meraki network-health heartbeat. Keeping this stable also lets legacy prompts
# that mention Dashboard SDK method names resolve against the REST catalog.
MERAKI_HEARTBEAT_CATALOG_QUERY = (
    "getOrganizations getOrganizationNetworks "
    "getOrganizationDevicesStatuses getOrganizationAssuranceAlerts"
)


# Concrete recipe appended to the Meraki agent's prompt for UNATTENDED
# heartbeat checks. This is the current runtime contract and deliberately
# supersedes stale SDK examples in previously saved heartbeat prompts.
_MERAKI_HEARTBEAT_GUIDANCE = f"""

==================================================================
CURRENT HEARTBEAT API CONTRACT — follow this EXACT recipe.
==================================================================
Reach the Meraki Dashboard ONLY through the pre-bound meraki_api_call(method,
path, ...) function. json.loads its result; data is under ['data']. GET lists
are auto-paginated. Do NOT use the meraki SDK or raw requests.

Before ANY Meraki API call, make exactly ONE TOP-LEVEL search_api_catalog call
(not Python) with:
  query="{MERAKI_HEARTBEAT_CATALOG_QUERY}"
  catalog_id="meraki"
  limit=5
The returned exact records authorize all four calls below. Do not run another
catalog search. If one is missing, report the missing live state as unknown.

Then use ONE execute_python_code block to:
  1. GET /organizations and select the exact organization named in the saved
     heartbeat prompt.
  2. GET /organizations/{{org_id}}/networks and select the exact target network
     name from the saved heartbeat prompt. Save its id as network_id.
  3. GET /organizations/{{org_id}}/devices/statuses with
     query_params={{"networkIds": [network_id]}}.
  4. GET /organizations/{{org_id}}/assurance/alerts with
     query_params={{"networkId": network_id, "active": True, "perPage": 100}}.
  5. Print only the target network's device status counts, non-online device
     details, and active-alert details needed for the final answer.

Never request organization-wide device statuses or alerts without those exact
target-network filters. Never include another network in the result. After the
single code block returns data, immediately write the concise FINAL summary.
Do not call write_todos, task, or any filesystem/planning tool; they are
intentionally unavailable in heartbeat mode.
"""


_MERAKI_HEARTBEAT_ROLE = """You are a focused, read-only Meraki heartbeat agent.
Use only the live Dashboard API workflow below. Never guess live state, never
substitute remembered data for an API result, and report unknown when an exact
catalog match or live API response is unavailable."""


_PYATS_HEARTBEAT_GUIDANCE = """

==================================================================
CURRENT PYATS HEARTBEAT API CONTRACT — follow this EXACT recipe.
==================================================================
The pre-bound `pyats` object is the TerminAI PyATS client. Do NOT import
`pyats.call`, `pyats.topology`, or any other low-level pyATS module.

Before the first PyATS operation, make exactly ONE TOP-LEVEL search_api_catalog
call (not Python) with:
  query="list-devices run-show-command device-health"
  catalog_id="pyats"
  limit=5
Use the returned operation records to authorize the client calls below. Do not
repeat discovery; if a required operation is missing, report that state as
unknown instead of guessing.

Then use as few execute_python_code blocks as possible, preferably one, to:
  1. Set `env = pyats.call("list-devices")`; its `env["data"]` value is a list
     of dictionaries, so set `names = [d["name"] for d in env["data"]]`.
  2. For each discovered name, call
     pyats.call("run-show-command", device=name,
                command="show logging | include ERROR|WARN|CRIT") exactly once.
  3. Summarize the returned data and stop. Never call the removed
     `show-command` verb and never guess device names.
"""


_PYATS_HEARTBEAT_ROLE = """You are a focused, read-only PyATS heartbeat agent.
Use only the live PyATS workflow below. Never guess device names or substitute
remembered state for a live operation result."""


# Universal efficiency directive appended to EVERY heartbeat agent's prompt.
# MEASURED 2026-06-30: on hosted gpt-oss-120b each execute_python_code round-trip
# costs 40-70s (the vendor API calls themselves are <1s), and the model was
# spreading one report across 8 steps — re-fetching the same devices/alerts in
# separate blocks — which blew every timeout ceiling. The sandbox is built ONCE
# and PERSISTS globals across calls, so there is no reason to re-fetch. Collapsing
# the work into 1-2 blocks is the difference between a check that finishes and one
# that times out. This is the durable fix; timeouts are just a safety net.
_HEARTBEAT_EFFICIENCY_DIRECTIVE = """

==================================================================
UNATTENDED CHECK — MINIMIZE ROUND-TRIPS (this is a hard requirement)
==================================================================
Each code execution is a slow network round-trip to the LLM. Your budget is a
FEW executions, not many. To stay in budget:
- Your sandbox PERSISTS: variables, imports and fetched data from one code block
  are STILL AVAILABLE in the next. NEVER re-fetch data you already pulled.
- Do ALL data gathering for the whole report in as FEW execute_python_code
  blocks as possible — ideally ONE block that fetches everything and prints it,
  then a second (optional) block only if you truly need a follow-up.
- Do NOT run one code block per report section. Fetch everything up front, hold
  it in variables, and assemble the final report from what you already have.
- When you have the data, WRITE THE FINAL ANSWER as text. Do not keep calling
  the tool to re-verify or re-format.
- If TerminAI says execute_python_code stdout was summarized and retained, use
  the sandbox-local `tool_output` helper in your next Python block:
  tool_output.stats(), tool_output.head(), tool_output.tail(),
  tool_output.grep(...), or tool_output.json(). It holds the latest stdout and
  is NOT a file or path, so do not pass it to `read_file`.
- If DeepAgents says a large tool result was saved under
  `/large_tool_results/...`, inspect it ONLY with the built-in `read_file`
  tool. That path belongs to DeepAgents' virtual filesystem and cannot be
  opened with Python, pathlib, or execute_python_code.
"""


# Timeout for agent execution. Kept just under the Rust runner's cap
# (src-tauri/src/heartbeat/runner.rs) so the Python side returns a clean
# "timeout" finding before Rust force-aborts the call. Multi-step agent runs
# can require several sequential remote-model round-trips even when the vendor
# API itself is fast, so this is a provider/model-neutral safety ceiling. Keep
# this < the Rust runner cap (600s) < bridge idle (720s).
AGENT_TIMEOUT_SECONDS = 540


def execute_check(agent_id: str, prompt: str, check_id: str) -> dict[str, Any]:
    """Execute a heartbeat check by running the specified agent.

    Args:
        agent_id: Agent identifier (meraki, pyats, stealthwatch, ise, cml, catalyst_center)
        prompt: The prompt/task to execute
        check_id: Unique ID for this check execution

    Returns:
        {
            "findings": [
                {
                    "severity": "critical" | "error" | "warning" | "info" | "ok",
                    "title": str,
                    "message": str,
                    "metadata": dict
                }
            ]
        }
    """
    try:
        # Load agent definition
        from ccie_sidecar.agent import load_agent

        agent = load_agent(agent_id)
        if not agent:
            return {
                "findings": [
                    {
                        "severity": "error",
                        "title": f"Agent not found: {agent_id}",
                        "message": f"The agent '{agent_id}' could not be loaded. Check that it exists in bundled-agents or ~/.ccie-terminal/agents/",
                        "metadata": {"check_id": check_id, "agent_id": agent_id}
                    }
                ]
            }

        # Execute agent with timeout
        result = asyncio.run(_run_agent_with_timeout(agent, agent_id, prompt, check_id))
        return result

    except Exception as e:
        # Catch-all: execution error
        return {
            "findings": [
                {
                    "severity": "error",
                    "title": "Check execution failed",
                    "message": f"Failed to execute heartbeat check: {str(e)}",
                    "metadata": {"check_id": check_id, "agent_id": agent_id, "error": str(e)}
                }
            ]
        }


async def _run_agent_with_timeout(
    agent: dict[str, Any],
    agent_id: str,
    prompt: str,
    check_id: str
) -> dict[str, Any]:
    """Run agent with timeout protection."""
    try:
        result = await asyncio.wait_for(
            _execute_agent(agent, agent_id, prompt, check_id),
            timeout=AGENT_TIMEOUT_SECONDS
        )
        return result
    except asyncio.TimeoutError:
        return {
            "findings": [
                {
                    "severity": "error",
                    "title": "Check execution timeout",
                    "message": f"The agent '{agent_id}' did not complete within {AGENT_TIMEOUT_SECONDS} seconds.",
                    "metadata": {"check_id": check_id, "agent_id": agent_id, "timeout_seconds": AGENT_TIMEOUT_SECONDS}
                }
            ]
        }


async def _execute_agent(
    agent: dict[str, Any],
    agent_id: str,
    prompt: str,
    check_id: str
) -> dict[str, Any]:
    """Execute the agent and parse its output into findings.

    Uses the deepagents CODE-EXEC engine (deepagents_react_code_loop): the LLM
    sees ONE execute_python_code tool and writes Python that calls the
    pre-loaded vendor client in the sandbox. This is the MCP design — we never
    bind the 933-endpoint catalog to the model (that caused a request/DNS storm
    and let the model call arbitrary write endpoints). The sandbox pre-loads the
    `cli_package` client (e.g. a `meraki` DashboardAPI) from Settings creds.
    """
    from ccie_sidecar.agents.deepagents_runtime import deepagents_react_code_loop
    from ccie_sidecar.agents.model_recovery import AgentExecutionPolicy
    from ccie_sidecar.agent import get_saved_config

    # Get the configured LLM provider from Settings (not hardcoded to Anthropic)
    config = get_saved_config()
    if not config:
        return {
            "findings": [
                {
                    "severity": "error",
                    "title": "LLM not configured",
                    "message": "No LLM provider is configured in Settings. Configure an LLM provider (OpenAI, Anthropic, etc.) to enable heartbeat checks.",
                    "metadata": {"check_id": check_id, "agent_id": agent_id}
                }
            ]
        }

    attached_tools = agent.get("attached_tools") or []
    if not attached_tools:
        return {
            "findings": [
                {
                    "severity": "error",
                    "title": f"Agent '{agent_id}' has no attached tools",
                    "message": f"Cannot execute agent '{agent_id}' because it has no attached tools configured.",
                    "metadata": {"check_id": check_id, "agent_id": agent_id}
                }
            ]
        }

    # Heartbeat checks run unattended (no vault-injected secrets). Resolve the
    # Settings-stored Meraki key so the sandbox's meraki_api_call helper can
    # authenticate. The code-exec sandbox reads vault_secrets/Settings to build
    # the client, and also honours MERAKI_API_KEY env.
    import os
    resolved_secrets: dict[str, Any] = {}
    if agent_id == "meraki":
        try:
            from ccie_sidecar.meraki_config import get_meraki_config
            mcfg = get_meraki_config()
            mkey = (mcfg or {}).get("api_key")
            if mkey:
                resolved_secrets["api_key"] = mkey
                os.environ.setdefault("MERAKI_API_KEY", mkey)
                os.environ.setdefault("MERAKI_DASHBOARD_API_KEY", mkey)
            else:
                return {
                    "findings": [
                        {
                            "severity": "error",
                            "title": "Meraki API key not configured",
                            "message": "No Meraki API key found. Save your Meraki API key in Settings → Meraki before running this check.",
                            "metadata": {"check_id": check_id, "agent_id": agent_id}
                        }
                    ]
                }
        except Exception as e:
            return {
                "findings": [
                    {
                        "severity": "error",
                        "title": "Meraki config error",
                        "message": f"Failed to read Meraki config: {str(e)}",
                        "metadata": {"check_id": check_id, "agent_id": agent_id}
                    }
                ]
            }

    tool = attached_tools[0]

    # Heartbeat-specific prompt guidance gives unattended vendor runs a bounded
    # discovery step and a compact live workflow. It also overrides stale
    # wording in prompts saved before catalog grounding was required.
    system_prompt = agent.get("system_prompt", "")
    if agent_id == "meraki":
        # User overrides are optimized for interactive chat and can be tens of
        # thousands of characters long. The unattended check needs only this
        # compact, current, read-only contract; the saved check prompt supplies
        # its exact organization/network scope.
        system_prompt = _MERAKI_HEARTBEAT_ROLE + _MERAKI_HEARTBEAT_GUIDANCE
    elif agent_id == "pyats":
        system_prompt = _PYATS_HEARTBEAT_ROLE + _PYATS_HEARTBEAT_GUIDANCE
    # Every heartbeat agent gets the round-trip-minimization directive — the
    # 8-steps-instead-of-2 blowup that broke checks was not Meraki-specific.
    system_prompt += _HEARTBEAT_EFFICIENCY_DIRECTIVE

    # Build the code-exec agent_def. The loop reads attached_tools[0].id as the
    # `cli_package` that selects which vendor client to pre-load in the sandbox,
    # and vault_secrets for that client's credentials. The runtime resolves the
    # raw catalog in-process and exposes only bounded search results to the model.
    agent_def = {
        "id": agent_id,
        "agent_id": agent_id,
        "system_prompt": system_prompt,
        "focused_api_mode": True,
        "attached_tools": [{
            "id": tool.get("id", agent_id),  # cli_package selector (e.g. "meraki")
            "vault_secrets": resolved_secrets,  # Settings-resolved creds
        }],
    }

    # Collect agent output events
    events: list[dict[str, Any]] = []

    def collect_event(event: dict[str, Any]) -> None:
        events.append(event)

    # Run the agent using the code-exec DeepAgents loop.
    try:
        outcome = await deepagents_react_code_loop(
            agent_def=agent_def,
            user_msg=prompt,
            ctx={"history": []},
            on_event=collect_event,
            execution_policy=AgentExecutionPolicy.from_environment(),
        )
    except Exception as e:
        return {
            "findings": [
                {
                    "severity": "error",
                    "title": "Agent execution error",
                    "message": f"Agent '{agent_id}' raised an exception: {str(e)}",
                    "metadata": {"check_id": check_id, "agent_id": agent_id, "error": str(e)}
                }
            ]
        }

    # Parse agent output into findings
    findings = _parse_agent_output(agent_id, events, check_id, outcome=outcome)
    return {"findings": findings, "execution": outcome}


def _parse_agent_output(
    agent_id: str,
    events: list[dict[str, Any]],
    check_id: str,
    outcome: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Parse agent events into structured findings.

    Extracts findings from agent text output based on agent-specific patterns.
    If no issues are found in the output, returns an empty findings list
    (interpreted as "ok" by the caller).
    """
    # Extract text output from agent events. The deepagents react loop emits
    # `final` events carrying the full response (and `token` events for legacy
    # streaming). Collect whichever is present. We also keep the last few
    # tool_result payloads as a FALLBACK: the model occasionally ends a turn
    # without a final text message even though its tool calls returned real
    # data — in that case we may surface a successful execute_python_code data
    # payload as degraded output. Planning, grading, and filesystem results are
    # not health data and never qualify for this fallback.
    has_structured_outcome = outcome is not None
    outcome = outcome or {}
    execution_metadata = {
        "final_emitted": bool(outcome.get("final_emitted")),
        "steps": int(outcome.get("steps") or 0),
        "error_kind": outcome.get("error_kind"),
        "error_type": outcome.get("error_type"),
        "recovery_attempts": int(outcome.get("recovery_attempts") or 0),
        "fallback_mode": outcome.get("fallback_mode"),
    }

    text_output = ""
    tool_result_texts: list[str] = []
    runtime_errors: list[dict[str, Any]] = []
    saw_final_event = False
    for event in events:
        etype = event.get("type")
        if etype == "final":
            # Deep agents: the complete response lives in `response`
            saw_final_event = True
            text_output += event.get("response", "") or ""
        elif etype == "token":
            # Legacy streaming: incremental text in `data`
            text_output += event.get("data", "") or ""
        elif etype == "tool_result":
            # Only the heartbeat's execute_python_code result contains vendor
            # check data. Planning/grader/built-in tool successes are workflow
            # metadata and must never be presented as a degraded health result.
            if event.get("success") and event.get("name") == "execute_python_code":
                result = str(event.get("result", ""))
                normalized_result = result.strip()
                if (
                    normalized_result
                    and normalized_result not in {"No matches found", "(no output)"}
                    and not result.lstrip().startswith("Error:")
                ):
                    tool_result_texts.append(result)
        elif etype == "error":
            runtime_errors.append(event)

    if not has_structured_outcome:
        execution_metadata["final_emitted"] = saw_final_event

    # A runtime failure is never converted into a clean check merely because a
    # partial final/tool result was emitted before the exception.
    if runtime_errors or execution_metadata["error_kind"]:
        event = runtime_errors[-1] if runtime_errors else {}
        error_kind = (
            execution_metadata["error_kind"]
            or event.get("kind")
            or "runtime"
        )
        error_type = execution_metadata["error_type"] or event.get("error_type")
        title = {
            "model_protocol": "Model response protocol error",
            "authentication": "Model authentication error",
            "configuration": "Model configuration error",
            "client_error": "Model request rejected",
            "rate_limit": "Model rate limit reached",
            "context_overflow": "Model context limit exceeded",
            "timeout": "Model request timeout",
            "tool": "Agent tool error",
            "step_limit": "Agent step limit reached",
        }.get(error_kind, "Agent runtime error")
        metadata = {
            "check_id": check_id,
            "agent_id": agent_id,
            "kind": error_kind,
            "degraded": False,
            **execution_metadata,
        }
        metadata["error_kind"] = error_kind
        metadata["error_type"] = error_type
        for key in ("initial_error_type", "fallback_error_type"):
            if event.get(key):
                metadata[key] = event[key]
        return [
            {
                "severity": "error",
                "title": title,
                "message": event.get(
                    "message",
                    f"Agent '{agent_id}' ended with a {error_kind} error.",
                ),
                "metadata": metadata,
            }
        ]

    # No final text but tool calls returned data → summarize from the tool
    # results so a successful data pull isn't reported as a failure.
    if not text_output.strip() and tool_result_texts:
        joined = "\n".join(t for t in tool_result_texts if t and t != "No matches found")
        if joined.strip():
            return [
                {
                    "severity": "info",
                    "title": f"{agent_id.title()} check completed (raw data)",
                    "message": (
                        "The agent gathered data but did not produce a final "
                        "summary. Raw tool results:\n\n" + joined[:3500]
                    ),
                    "metadata": {
                        "check_id": check_id,
                        "agent_id": agent_id,
                        "kind": "tool_fallback",
                        "degraded": True,
                        **execution_metadata,
                    },
                }
            ]

    # If genuinely no output at all, return error finding
    if not text_output.strip():
        return [
            {
                "severity": "error",
                "title": "No agent output",
                "message": f"Agent '{agent_id}' produced no output.",
                "metadata": {
                    "check_id": check_id,
                    "agent_id": agent_id,
                    "kind": "empty_final",
                    "degraded": False,
                    **execution_metadata,
                    "error_kind": "empty_final",
                },
            }
        ]

    # Run the agent-specific keyword parser to detect specific issues
    # (offline devices, critical alerts, etc.) that drive severity.
    if agent_id == "pyats":
        specific = _parse_pyats_output(text_output, check_id)
    elif agent_id == "meraki":
        specific = _parse_meraki_output(text_output, check_id)
    elif agent_id == "stealthwatch":
        specific = _parse_stealthwatch_output(text_output, check_id)
    elif agent_id == "ise":
        specific = _parse_ise_output(text_output, check_id)
    elif agent_id == "cml":
        specific = _parse_cml_output(text_output, check_id)
    elif agent_id == "catalyst_center":
        specific = _parse_catalyst_center_output(text_output, check_id)
    else:
        specific = _parse_generic_output(text_output, check_id, agent_id)

    # ALWAYS surface the agent's actual summary as a finding so the user sees
    # what the agent reported. The keyword parsers above only fire on specific
    # problem signals; without this, a clean run would show nothing at all.
    # Severity = "ok" when no specific issues, else the worst specific severity.
    severity_rank = {"ok": 0, "info": 1, "warning": 2, "error": 3, "critical": 4}
    worst = "ok"
    for f in specific:
        if severity_rank.get(f.get("severity", "ok"), 0) > severity_rank.get(worst, 0):
            worst = f["severity"]

    summary_severity = worst if specific else "ok"

    # If the agent itself reported it could not complete the check (API errors,
    # service unavailable, auth failures), surface that as a warning even when
    # the keyword parsers found no specific device-level issues.
    if not specific:
        low = text_output.lower()
        failure_signals = [
            "unable to", "couldn't", "could not", "can't", "cannot",
            "503", "502", "500", "service unavailable", "timed out",
            "timeout", "failed to", "error retrieving", "api is returning",
            "try again later",
        ]
        if any(sig in low for sig in failure_signals):
            summary_severity = "warning"
    # Trim the summary so a huge dump doesn't overwhelm the finding card.
    summary_msg = text_output.strip()
    if len(summary_msg) > 4000:
        summary_msg = summary_msg[:4000] + "\n\n…(truncated)"

    summary_finding = {
        "severity": summary_severity,
        "title": f"{agent_id.title()} check summary",
        "message": summary_msg,
        "metadata": {
            "check_id": check_id,
            "agent_id": agent_id,
            "kind": "summary",
            "degraded": False,
            **execution_metadata,
        },
    }

    return [summary_finding] + specific


def _parse_pyats_output(text: str, check_id: str) -> list[dict[str, Any]]:
    """Parse pyATS agent output for test results and failures."""
    findings: list[dict[str, Any]] = []

    # Look for common pyATS test result indicators
    text_lower = text.lower()

    # Check for explicit "passed" or "failed" mentions (but not negated failures)
    has_failure = "failed" in text_lower or "failure" in text_lower
    if has_failure:
        # Check for negation patterns that indicate NO failures
        negation_patterns = [
            "no anomalies or failures",
            "no failures",
            "no anomalies",
            "not failed",
            "0 failed",
            "zero failures",
            "none failed",
            "no test failures",
            "without failures",
        ]
        is_negated = any(pattern in text_lower for pattern in negation_patterns)

        if not is_negated:
            # Real failure detected - extract failure details
            failure_lines = [line for line in text.split("\n") if "fail" in line.lower()]
            for line in failure_lines[:5]:  # Limit to first 5 failures
                findings.append({
                    "severity": "error",
                    "title": "Test failure detected",
                    "message": line.strip(),
                    "metadata": {"check_id": check_id, "agent_id": "pyats"}
                })

    # Check for device unreachable
    if "unreachable" in text_lower or "not reachable" in text_lower or "connection refused" in text_lower:
        findings.append({
            "severity": "critical",
            "title": "Device unreachable",
            "message": "One or more devices could not be reached during health check.",
            "metadata": {"check_id": check_id, "agent_id": "pyats"}
        })

    # Check for interface down
    if "interface down" in text_lower or "down/down" in text_lower:
        findings.append({
            "severity": "warning",
            "title": "Interface down",
            "message": "One or more interfaces are in down state.",
            "metadata": {"check_id": check_id, "agent_id": "pyats"}
        })

    # If nothing found and output looks positive, it's a pass
    if not findings and ("passed" in text_lower or "success" in text_lower or "healthy" in text_lower):
        return []  # Empty = OK

    return findings if findings else []


def _parse_meraki_output(text: str, check_id: str) -> list[dict[str, Any]]:
    """Parse Meraki agent output for alerts and device issues."""
    findings: list[dict[str, Any]] = []
    text_lower = text.lower()

    # Check for offline devices, but avoid false positives on phrasings like
    # "0 offline", "no offline", "none offline", "0 devices offline".
    has_offline = "offline" in text_lower or "not online" in text_lower
    negated_offline = any(
        neg in text_lower
        for neg in ["0 offline", "no offline", "none offline", "0 devices offline",
                    "zero offline", "no devices offline", "0 device offline"]
    )
    if has_offline and not negated_offline:
        findings.append({
            "severity": "error",
            "title": "Offline devices detected",
            "message": "One or more Meraki devices are offline.",
            "metadata": {"check_id": check_id, "agent_id": "meraki"}
        })

    # Check for alerts
    if "alert" in text_lower and "critical" in text_lower:
        findings.append({
            "severity": "critical",
            "title": "Critical alerts",
            "message": "Critical alerts detected in Meraki dashboard.",
            "metadata": {"check_id": check_id, "agent_id": "meraki"}
        })
    elif "alert" in text_lower and ("warning" in text_lower or "warn" in text_lower):
        findings.append({
            "severity": "warning",
            "title": "Warning alerts",
            "message": "Warning alerts detected in Meraki dashboard.",
            "metadata": {"check_id": check_id, "agent_id": "meraki"}
        })

    # Check for connectivity issues
    if "connectivity" in text_lower and ("issue" in text_lower or "problem" in text_lower):
        findings.append({
            "severity": "error",
            "title": "Connectivity issues",
            "message": "Connectivity problems detected in Meraki network.",
            "metadata": {"check_id": check_id, "agent_id": "meraki"}
        })

    return findings


def _parse_stealthwatch_output(text: str, check_id: str) -> list[dict[str, Any]]:
    """Parse Stealthwatch output for security alerts."""
    findings: list[dict[str, Any]] = []
    text_lower = text.lower()

    # Check for high-severity alerts
    if "high severity" in text_lower or "critical" in text_lower:
        findings.append({
            "severity": "critical",
            "title": "High-severity security alerts",
            "message": "High-severity or critical security alerts detected in Stealthwatch.",
            "metadata": {"check_id": check_id, "agent_id": "stealthwatch"}
        })

    # Check for threats
    if "threat" in text_lower or "malicious" in text_lower:
        findings.append({
            "severity": "error",
            "title": "Security threats detected",
            "message": "Potential security threats identified by Stealthwatch.",
            "metadata": {"check_id": check_id, "agent_id": "stealthwatch"}
        })

    # Check for anomalies
    if "anomal" in text_lower or "unusual" in text_lower:
        findings.append({
            "severity": "warning",
            "title": "Anomalous behavior",
            "message": "Unusual network behavior detected by Stealthwatch.",
            "metadata": {"check_id": check_id, "agent_id": "stealthwatch"}
        })

    return findings


def _parse_ise_output(text: str, check_id: str) -> list[dict[str, Any]]:
    """Parse ISE output for authentication and policy issues."""
    findings: list[dict[str, Any]] = []
    text_lower = text.lower()

    # Check for failed authentications (but not "no failures")
    if ("failed auth" in text_lower or "authentication fail" in text_lower) and "no" not in text_lower[:text_lower.find("fail")]:
        findings.append({
            "severity": "error",
            "title": "Failed authentications",
            "message": "Authentication failures detected in ISE.",
            "metadata": {"check_id": check_id, "agent_id": "ise"}
        })

    # Check for policy violations
    if "policy violation" in text_lower or "non-compliant" in text_lower:
        findings.append({
            "severity": "warning",
            "title": "Policy violations",
            "message": "Policy violations or non-compliant endpoints detected.",
            "metadata": {"check_id": check_id, "agent_id": "ise"}
        })

    # Check for service issues
    if "service" in text_lower and ("down" in text_lower or "unavailable" in text_lower):
        findings.append({
            "severity": "critical",
            "title": "ISE service issues",
            "message": "ISE services are down or unavailable.",
            "metadata": {"check_id": check_id, "agent_id": "ise"}
        })

    return findings


def _parse_cml_output(text: str, check_id: str) -> list[dict[str, Any]]:
    """Parse CML output for lab status issues."""
    findings: list[dict[str, Any]] = []
    text_lower = text.lower()

    # Check for stopped labs
    if "stopped" in text_lower or "not running" in text_lower:
        findings.append({
            "severity": "warning",
            "title": "Stopped labs",
            "message": "One or more CML labs are stopped.",
            "metadata": {"check_id": check_id, "agent_id": "cml"}
        })

    # Check for node failures (but not "no node failures")
    if ("node fail" in text_lower or "failed node" in text_lower) and "no " not in text_lower[:max(0, text_lower.find("fail")-5)]:
        findings.append({
            "severity": "error",
            "title": "Node failures",
            "message": "CML simulation nodes have failed.",
            "metadata": {"check_id": check_id, "agent_id": "cml"}
        })

    # Check for resource issues
    if "resource" in text_lower and ("exhaust" in text_lower or "limit" in text_lower):
        findings.append({
            "severity": "warning",
            "title": "Resource constraints",
            "message": "CML is experiencing resource constraints.",
            "metadata": {"check_id": check_id, "agent_id": "cml"}
        })

    return findings


def _parse_catalyst_center_output(text: str, check_id: str) -> list[dict[str, Any]]:
    """Parse Catalyst Center output for network assurance issues."""
    findings: list[dict[str, Any]] = []
    text_lower = text.lower()

    # Check for critical issues (but not "no critical issues")
    if "critical issue" in text_lower or "severity: critical" in text_lower:
        # Look for negation patterns before "critical"
        critical_pos = text_lower.find("critical")
        context = text_lower[max(0, critical_pos-20):critical_pos+20]
        if "no " not in context and "no critical" not in text_lower:
            findings.append({
                "severity": "critical",
                "title": "Critical network issues",
                "message": "Critical network issues detected in Catalyst Center assurance.",
                "metadata": {"check_id": check_id, "agent_id": "catalyst_center"}
            })

    # Check for device health
    if "device health" in text_lower and ("poor" in text_lower or "critical" in text_lower):
        findings.append({
            "severity": "error",
            "title": "Poor device health",
            "message": "Devices with poor health scores detected.",
            "metadata": {"check_id": check_id, "agent_id": "catalyst_center"}
        })

    # Check for client connectivity (but not "no client issues")
    if "client" in text_lower and ("issue" in text_lower or "problem" in text_lower):
        # Look for negation
        client_pos = text_lower.find("client")
        issue_pos = max(text_lower.find("issue"), text_lower.find("problem"))
        context = text_lower[max(0, client_pos-10):issue_pos+10]
        if "no " not in context:
            findings.append({
                "severity": "warning",
                "title": "Client connectivity issues",
                "message": "Client connectivity problems detected.",
                "metadata": {"check_id": check_id, "agent_id": "catalyst_center"}
            })

    return findings


def _parse_generic_output(text: str, check_id: str, agent_id: str) -> list[dict[str, Any]]:
    """Generic parser for unknown agent types.

    Looks for common severity keywords and failure indicators.
    """
    findings: list[dict[str, Any]] = []
    text_lower = text.lower()

    # Check for explicit severity mentions
    if "critical" in text_lower or "severe" in text_lower:
        findings.append({
            "severity": "critical",
            "title": "Critical issue detected",
            "message": "Critical issues mentioned in agent output.",
            "metadata": {"check_id": check_id, "agent_id": agent_id}
        })
    elif "error" in text_lower or "fail" in text_lower:
        findings.append({
            "severity": "error",
            "title": "Errors detected",
            "message": "Errors or failures mentioned in agent output.",
            "metadata": {"check_id": check_id, "agent_id": agent_id}
        })
    elif "warning" in text_lower or "warn" in text_lower:
        findings.append({
            "severity": "warning",
            "title": "Warnings detected",
            "message": "Warnings mentioned in agent output.",
            "metadata": {"check_id": check_id, "agent_id": agent_id}
        })

    return findings
