"""NDJSON stdio server. One JSON object per line on stdin; responses on stdout."""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from dataclasses import asdict, is_dataclass
from typing import Any, TextIO

from ccie_sidecar.agent import chat_stream, chat_stream_with_agent, explain_error_stream
from ccie_sidecar import command_intelligence


# Heartbeat cadence. Plan 00 / Task 3.3 specifies 30s; overridable via env
# for tests and local debugging.
HEARTBEAT_INTERVAL_S = int(os.environ.get("CCIE_SIDECAR_HEARTBEAT_S", "30"))

# Serialize stdout writes so the background heartbeat thread doesn't interleave
# bytes with response lines from the request handler.
_STDOUT_LOCK = threading.Lock()


def build_deepagents_agent_definition(
    *,
    agent_id: str,
    system_prompt: str,
    tools: Any,
    vault_entry: str | None = None,
    vault_secrets: dict[str, str] | None = None,
    tool_id: str | None = None,
    topolograph_runtime: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the sidecar definition while keeping connector data out of prompts."""
    definition: dict[str, Any] = {
        "id": agent_id,
        "agent_id": agent_id,
        "system_prompt": system_prompt,
        "attached_tools": [{
            "catalog": tools,
            "id": tool_id,
            "vault_entry": vault_entry,
            "vault_secrets": vault_secrets or {},
        }],
    }
    if topolograph_runtime is not None:
        from ccie_sidecar.agents.architect_subagents import TopolographAgentBinding
        definition["topolograph_binding"] = TopolographAgentBinding(**topolograph_runtime)
    return definition


def _safe_topolograph_json(value: Any) -> Any:
    """Return JSON-compatible adapter data without stringifying unknown data."""
    if is_dataclass(value):
        return _safe_topolograph_json(asdict(value))
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [_safe_topolograph_json(item) for item in value]
    if isinstance(value, dict):
        return {
            str(key): _safe_topolograph_json(item)
            for key, item in value.items()
            if isinstance(key, (str, int, float, bool))
        }
    return {"type": type(value).__name__}


def _bounded_topolograph_result(value: Any) -> dict[str, Any]:
    """Expose operation metadata, never raw graph/MCP payloads."""
    if not isinstance(value, dict):
        return {"ok": True, "summary": "Topolograph operation completed."}
    result: dict[str, Any] = {"ok": bool(value.get("ok", True))}
    for key in ("server_name", "server_version", "latency_ms", "bytes", "accepted", "vendor", "protocol", "unexpected_tools"):
        item = value.get(key)
        if isinstance(item, (int, float, bool)):
            result[key] = item
        elif isinstance(item, str):
            result[key] = item[:160]
        elif isinstance(item, list) and all(isinstance(x, str) for x in item):
            result[key] = [item[:80] for item in item[:50]]
    warnings = value.get("warnings")
    if isinstance(warnings, list):
        result["warning_count"] = len(warnings)
    stages = value.get("stages")
    if isinstance(stages, list):
        allowed_stage_names = {"initialize", "tool_inventory", "bounded_probe", "connection"}
        result["stages"] = [
            {"name": stage["name"], "status": stage["status"]}
            for stage in stages
            if isinstance(stage, dict)
            and stage.get("name") in allowed_stage_names
            and stage.get("status") in {"passed", "failed", "skipped"}
        ]
    result.setdefault("summary", "Topolograph operation completed.")
    return result


def _topolograph_error_response(req_id: str, code: str, message: str) -> dict[str, Any]:
    """Build a fixed-shape, non-sensitive sidecar error envelope."""
    return {
        "id": req_id,
        "type": "error",
        "code": code,
        "message": f"Topolograph operation failed: {code}: {message}",
    }


def _topolograph_client(params: Any):
    """Construct the client inside the request scope so its token stays private."""
    if not isinstance(params, dict):
        raise ValueError("Topolograph params must be an object.")
    base_url = params.get("base_url")
    verify_tls = params.get("verify_tls")
    token = params.get("token", "")
    if not isinstance(base_url, str) or not base_url.strip():
        raise ValueError("Topolograph base_url must be a non-empty string.")
    if not isinstance(verify_tls, bool):
        raise ValueError("Topolograph verify_tls must be a boolean.")
    if not isinstance(token, str):
        raise ValueError("Topolograph token must be a string.")
    if not params.get("enabled", False):
        raise ValueError("CONNECTOR_DISABLED")
    if not params.get("configured", False):
        raise ValueError("CONNECTOR_UNCONFIGURED")
    if not params.get("unlocked", False):
        raise ValueError("CONNECTOR_LOCKED")
    if not token:
        raise ValueError("TOKEN_REQUIRED")

    from ccie_sidecar.topolograph import TopolographClient, TopolographRuntimeConfig

    return TopolographClient(
        TopolographRuntimeConfig(base_url=base_url, verify_tls=verify_tls),
        token,
    )


def _handle_topolograph_request(req_id: str, method: str, params: Any) -> dict[str, Any]:
    """Dispatch direct Topolograph calls without routing through generic MCP."""
    try:
        if not isinstance(params, dict):
            raise ValueError("Topolograph params must be an object.")
        if method == "topolograph.call_tool":
            name = params.get("name")
            arguments = params.get("arguments", {})
            if not isinstance(name, str) or not name.strip():
                raise ValueError("Topolograph call_tool name must be a non-empty string.")
            if not isinstance(arguments, dict):
                raise ValueError("Topolograph call_tool arguments must be an object.")
            if name == "delete_lsp" and not (arguments.get("lsp_name") or arguments.get("delete_all") is True):
                raise ValueError("delete_lsp requires lsp_name or delete_all=true")
        elif method == "topolograph.upload_lsdb":
            content = params.get("content")
            vendor = params.get("vendor")
            protocol = params.get("protocol")
            description = params.get("description")
            if not isinstance(content, str) or not content.strip():
                raise ValueError("Topolograph upload_lsdb content must be non-empty text.")
            if not isinstance(vendor, str) or not vendor.strip():
                raise ValueError("Topolograph upload_lsdb vendor must be a non-empty string.")
            if not isinstance(protocol, str) or not protocol.strip():
                raise ValueError("Topolograph upload_lsdb protocol must be a non-empty string.")
            if description is not None and not isinstance(description, str):
                raise ValueError("Topolograph upload_lsdb description must be a string.")
        elif method == "topolograph.upload_yaml":
            content = params.get("content")
            if not isinstance(content, str) or not content.strip():
                raise ValueError("Topolograph upload_yaml content must be non-empty text.")

        client = _topolograph_client(params)
        if method == "topolograph.test_connection":
            result = client.test_connection()
        elif method == "topolograph.call_tool":
            arguments = params.get("arguments", {})
            result = client.call_tool(name, arguments)
        elif method == "topolograph.upload_lsdb":
            content = params.get("content")
            vendor = params.get("vendor")
            protocol = params.get("protocol")
            description = params.get("description")
            result = client.upload_lsdb(content, vendor, protocol, description)
        else:
            content = params.get("content")
            result = client.upload_yaml(content)
        return {"id": req_id, "type": "done", "result": _bounded_topolograph_result(_safe_topolograph_json(result))}
    except ValueError as error:
        code = str(error) if str(error) in {"CONNECTOR_DISABLED", "CONNECTOR_UNCONFIGURED", "CONNECTOR_LOCKED", "TOKEN_REQUIRED"} else "INVALID_PARAMETERS"
        return _topolograph_error_response(req_id, code, "The adapter parameters were rejected.")
    except Exception as error:
        from ccie_sidecar.topolograph import TopolographError

        if isinstance(error, TopolographError):
            return _topolograph_error_response(
                req_id, error.code, "The adapter request was not completed."
            )
        return _topolograph_error_response(
            req_id, "ADAPTER_FAILURE", "The adapter request was not completed."
        )


_STP_SAFE_FIELDS = {
    "devices", "device", "platform", "status", "stp", "neighbors", "bundle", "gaps",
    "mode", "instances", "ports", "interfaces", "cdp", "lldp", "source", "code",
    "id", "bridge_address", "bridge_id", "bridge_priority", "cost", "device_id",
    "interface", "local_interface", "members", "mst_id", "path_cost", "port_id",
    "port_state", "priority", "protocol", "role", "root_bridge", "root_id", "root_port",
    "state", "vlan", "vlan_id", "instance", "bundle_id", "name", "bidirectional",
    "topology_changes", "topology_change_count", "mst_region", "region",
    "inconsistent", "broken", "channel_group", "port_channel",
    "adjacencies", "findings", "local_device_id", "remote_device_id", "confidence",
    "remote_device", "remote_interface", "member_interfaces", "message", "severity",
    "scope_type", "scope_id", "vlan_ids", "root_priority", "root_cost", "timers",
    "hello_time", "max_age", "forward_delay",
}

_STP_SENSITIVE_TEXT = re.compile(
    r"(?i)\b(?:(?:authorization|token|password|secret|api[_ -]?key|access[_ -]?key)"
    r"\s*[:=]\s*(?:(?:bearer|basic)\s+)?[^\s,;]+|bearer\s+[^\s,;]+)"
)


def _safe_stp_result(value: Any) -> dict[str, Any]:
    """Keep the STP RPC constrained to the normalized evidence schema."""
    def sanitize(item: Any) -> Any:
        if isinstance(item, str):
            return _STP_SENSITIVE_TEXT.sub("[REDACTED]", item)
        if item is None or isinstance(item, (int, float, bool)):
            return item
        if isinstance(item, list):
            return [sanitize(entry) for entry in item]
        if isinstance(item, dict):
            return {
                key: sanitize(entry)
                for key, entry in item.items()
                if key in _STP_SAFE_FIELDS
            }
        return None

    result = sanitize(value)
    if not isinstance(result, dict):
        return {"status": "failed", "devices": []}
    devices = result.get("devices")
    response = {
        "status": result.get("status") if isinstance(result.get("status"), str) else "failed",
        "devices": devices if isinstance(devices, list) else [],
    }
    if isinstance(result.get("code"), str):
        response["code"] = result["code"]
    for field in ("adjacencies", "findings"):
        if isinstance(result.get(field), list):
            response[field] = sanitize(result[field])
    return response


def _package_version() -> str:
    """Best-effort read of the installed ccie-sidecar version."""
    try:
        from importlib.metadata import version

        return version("ccie-sidecar")
    except Exception:  # pragma: no cover
        return "0.0.0"


def _emit_heartbeat(stdout: TextIO, started_at: float) -> None:
    msg = {
        "id": "",
        "type": "sidecar.heartbeat",
        "payload": {
            "version": _package_version(),
            "pid": os.getpid(),
            "uptime_s": int(time.monotonic() - started_at),
        },
    }
    # stdout is already wrapped by `_LockedStdout` in run_loop, so write+flush
    # are atomic against the request handler.
    stdout.write(json.dumps(msg) + "\n")
    stdout.flush()


def _start_heartbeat(stdout: TextIO) -> threading.Thread:
    """Spawn a daemon thread that emits `sidecar.heartbeat` every 30s."""
    started_at = time.monotonic()

    def loop() -> None:
        # Send one immediately so the supervisor learns liveness without
        # waiting a full interval.
        try:
            _emit_heartbeat(stdout, started_at)
        except Exception:
            return
        while True:
            time.sleep(HEARTBEAT_INTERVAL_S)
            try:
                _emit_heartbeat(stdout, started_at)
            except Exception:
                # Stdout closed — parent died. Stop heartbeating.
                return

    t = threading.Thread(target=loop, name="ccie-sidecar-heartbeat", daemon=True)
    t.start()
    return t


def handle_request(req: dict[str, Any]) -> dict[str, Any]:
    """Handle a single request and return a response."""
    req_id = str(req.get("id", ""))
    method = req.get("method")
    params = req.get("params", {})

    if method == "topolograph.import_lsdb_from_pyats":
        from ccie_sidecar.topolograph_pyats_import import (
            TopolographPyatsLsdbRequestHandler,
        )

        return TopolographPyatsLsdbRequestHandler().handle(req_id, params)

    if method in {
        "topolograph.test_connection",
        "topolograph.call_tool",
        "topolograph.upload_lsdb",
        "topolograph.upload_yaml",
    }:
        return _handle_topolograph_request(req_id, method, params)

    if method == "stp.collect":
        try:
            from ccie_sidecar.stp_worker import collect_stp

            return {"id": req_id, "type": "done", "result": _safe_stp_result(collect_stp())}
        except Exception:
            return {"id": req_id, "type": "error", "message": "STP collection was not completed."}

    if method == "ping":
        return {"id": req_id, "type": "done", "result": "pong"}

    elif method == "whatsapp.link":
        try:
            from ccie_sidecar.whatsapp_bridge import get_bridge
            from ccie_sidecar.whatsapp_config import get_whatsapp_config

            cfg = get_whatsapp_config()
            session_dir = params.get("session_dir") or cfg["session_dir"]
            allowlist = params.get("allowlist") or cfg["allowlist"]
            bound_chat = params.get("bound_chat")
            if bound_chat is None:
                bound_chat = cfg.get("bound_chat", "")
            result = get_bridge().link(session_dir, allowlist, bound_chat)
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "whatsapp.list_groups":
        try:
            from ccie_sidecar.whatsapp_bridge import get_bridge

            return {"id": req_id, "type": "done", "result": get_bridge().list_groups()}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "whatsapp.unlink":
        try:
            from ccie_sidecar.whatsapp_bridge import get_bridge

            return {"id": req_id, "type": "done", "result": get_bridge().unlink()}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "whatsapp.status":
        try:
            from ccie_sidecar.whatsapp_bridge import get_bridge

            return {"id": req_id, "type": "done", "result": get_bridge().status()}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "whatsapp.poll":
        try:
            from ccie_sidecar.whatsapp_bridge import get_bridge

            return {"id": req_id, "type": "done", "result": {"messages": get_bridge().poll()}}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "whatsapp.send":
        try:
            from ccie_sidecar.whatsapp_bridge import get_bridge

            to = params.get("to", "")
            text = params.get("text", "")
            if not to or not text:
                return {"id": req_id, "type": "error", "message": "whatsapp.send requires 'to' and 'text'"}
            return {"id": req_id, "type": "done", "result": get_bridge().send(to, text)}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "chat.stream":
        # Validate required parameters
        session_id = params.get("session_id")
        messages = params.get("messages")
        if not session_id or not messages:
            return {
                "id": req_id,
                "type": "error",
                "message": "chat.stream requires 'session_id' and 'messages' parameters"
            }
        # This is a streaming method - will be handled in run_loop
        return {"id": req_id, "type": "stream", "method": method, "params": params}

    elif method == "chat.stream_agent":
        session_id = params.get("session_id")
        messages = params.get("messages")
        agent_id = params.get("agent_id")
        if not session_id or not messages or not agent_id:
            return {
                "id": req_id,
                "type": "error",
                "message": "chat.stream_agent requires 'session_id', 'messages', and 'agent_id' parameters"
            }
        return {"id": req_id, "type": "stream", "method": method, "params": params}

    elif method == "nl_to_command":
        # Real natural language to command translation using AI
        nl_query = params.get("nl_query", "")
        shell = params.get("shell", "bash")
        cwd = params.get("cwd", "")
        profile = params.get("profile", "default")
        try:
            from ccie_sidecar.agent import nl_to_command
            command = nl_to_command(
                nl_query=nl_query,
                shell=shell,
                cwd=cwd,
                profile=profile,
            )
            return {"id": req_id, "type": "done", "result": {"command": command}}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "explain_api_response":
        # Plain-English summary of an HTTP JSON response, for non-devops users.
        api_method = params.get("method", "GET")
        url = params.get("url", "")
        status_code = params.get("status_code", 0)
        body = params.get("body", "")
        profile = params.get("profile", "default")
        if not isinstance(body, str):
            return {
                "id": req_id,
                "type": "error",
                "message": "explain_api_response 'body' must be a decoded text string",
            }
        try:
            from ccie_sidecar.agent import explain_api_response
            summary = explain_api_response(
                method=api_method,
                url=url,
                status_code=int(status_code),
                body=body,
                profile=profile,
            )
            return {"id": req_id, "type": "done", "result": {"summary": summary}}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "explain_yang_module":
        # Plain-English explanation of a YANG module
        module_name = params.get("module_name", "")
        yang_content = params.get("yang_content", "")
        profile = params.get("profile", "default")
        if not isinstance(yang_content, str):
            return {
                "id": req_id,
                "type": "error",
                "message": "explain_yang_module 'yang_content' must be a string",
            }
        try:
            from ccie_sidecar.agent import explain_yang_module
            summary = explain_yang_module(
                module_name=module_name,
                yang_content=yang_content,
                profile=profile,
            )
            return {"id": req_id, "type": "done", "result": {"summary": summary}}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "explain_netconf_response":
        # Plain-English summary of a NETCONF XML response
        operation = params.get("operation", "unknown")
        response_xml = params.get("response_xml", "")
        profile = params.get("profile", "default")
        if not isinstance(response_xml, str):
            return {
                "id": req_id,
                "type": "error",
                "message": "explain_netconf_response 'response_xml' must be a string",
            }
        try:
            from ccie_sidecar.agent import explain_netconf_response
            summary = explain_netconf_response(
                operation=operation,
                response_xml=response_xml,
                profile=profile,
            )
            return {"id": req_id, "type": "done", "result": {"summary": summary}}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "explain_error":
        # Validate required parameters
        cmd = params.get("cmd")
        output = params.get("output")
        exit_code = params.get("exit_code")
        if cmd is None or output is None or exit_code is None:
            return {
                "id": req_id,
                "type": "error",
                "message": "explain_error requires 'cmd', 'output', and 'exit_code' parameters"
            }
        # This is a streaming method - will be handled in run_loop
        return {"id": req_id, "type": "stream", "method": method, "params": params}

    elif method == "explain_command":
        # Explain what a shell command does in plain English
        command = params.get("command")
        cwd = params.get("cwd", "/")
        profile = params.get("profile", "default")
        if not command:
            return {
                "id": req_id,
                "type": "error",
                "message": "explain_command requires 'command' parameter"
            }
        try:
            from ccie_sidecar.agent import explain_command
            explanation = explain_command(
                command=command,
                cwd=cwd,
                profile=profile,
            )
            return {"id": req_id, "type": "done", "result": {"explanation": explanation}}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "generate_skill":
        # Generate a skill definition using AI
        description = params.get("description", "")
        examples = params.get("examples", "")
        profile = params.get("profile", "default")
        if not description:
            return {
                "id": req_id,
                "type": "error",
                "message": "generate_skill requires 'description' parameter"
            }
        try:
            from ccie_sidecar.agent import generate_skill
            result = generate_skill(
                description=description,
                examples=examples,
                profile=profile,
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "invoke_skill":
        # Validate required parameters
        skill_name = params.get("skill_name")
        if not skill_name:
            return {
                "id": req_id,
                "type": "error",
                "message": "invoke_skill requires 'skill_name' parameter"
            }

        # Load the skill
        from ccie_sidecar import skills
        skill = skills.get_skill(skill_name)
        if not skill:
            return {
                "id": req_id,
                "type": "error",
                "message": f"Skill not found: {skill_name}"
            }

        # Invoke the skill
        args = params.get("args", "")
        context = params.get("context", {})
        profile = params.get("profile", "default")

        try:
            from ccie_sidecar.agent import invoke_skill_manual
            response = invoke_skill_manual(
                skill=skill,
                args=args,
                context=context,
                profile=profile,
            )
            return {"id": req_id, "type": "done", "result": {"response": response}}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "generate_skill":
        # Generate SKILL.md from natural language description
        description = params.get("description", "")
        examples = params.get("examples", None)
        profile = params.get("profile", "default")

        if not description:
            return {
                "id": req_id,
                "type": "error",
                "message": "generate_skill requires 'description' parameter"
            }

        try:
            from ccie_sidecar.skill_author import generate_skill
            result = generate_skill(
                description=description,
                examples=examples,
                profile=profile,
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "execute_skill_script":
        # Execute a skill's helper script
        skill_name = params.get("skill_name")
        script_name = params.get("script_name")
        if not skill_name or not script_name:
            return {
                "id": req_id,
                "type": "error",
                "message": "execute_skill_script requires 'skill_name' and 'script_name' parameters"
            }
        args = params.get("args", [])
        timeout = params.get("timeout", 30)
        try:
            from ccie_sidecar.skills import execute_skill_script
            result = execute_skill_script(
                skill_name=skill_name,
                script_name=script_name,
                args=args,
                timeout=timeout,
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "match_skill":
        # Match user query against available skills
        query = params.get("query")
        if not query:
            return {
                "id": req_id,
                "type": "error",
                "message": "match_skill requires 'query' parameter"
            }
        max_results = params.get("max_results", 3)
        try:
            from ccie_sidecar.skills import match_skill
            matches = match_skill(user_query=query, max_results=max_results)
            return {"id": req_id, "type": "done", "result": {"matches": matches}}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "yang_download":
        # Download and index a YANG release - streaming method
        vendor = params.get("vendor")
        os_name = params.get("os")
        release = params.get("release")
        cache_base = params.get("cache_base")
        if not all([vendor, os_name, release, cache_base]):
            return {
                "id": req_id,
                "type": "error",
                "message": "yang_download requires vendor, os, release, cache_base",
            }
        return {"id": req_id, "type": "stream", "method": method, "params": params}

    elif method == "suggest_command":
        # AI-powered command suggestions
        partial_command = params.get("partial_command", "")
        cwd = params.get("cwd", "/")
        max_suggestions = params.get("max_suggestions", 5)
        profile = params.get("profile", "default")
        pane_context = params.get("pane_context", "")
        if not partial_command:
            return {
                "id": req_id,
                "type": "error",
                "message": "suggest_command requires 'partial_command' parameter"
            }
        try:
            intelligence = command_intelligence.get_instance()
            result = intelligence.suggest_command(
                partial_command=partial_command,
                cwd=cwd,
                max_suggestions=max_suggestions,
                profile=profile,
                pane_context=pane_context,
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "natural_to_command":
        # Convert natural language to shell command
        natural_language = params.get("natural_language", "")
        cwd = params.get("cwd", "/")
        profile = params.get("profile", "default")
        pane_context = params.get("pane_context", "")
        if not natural_language:
            return {
                "id": req_id,
                "type": "error",
                "message": "natural_to_command requires 'natural_language' parameter"
            }
        try:
            intelligence = command_intelligence.get_instance()
            result = intelligence.natural_to_command(
                natural_language=natural_language,
                cwd=cwd,
                profile=profile,
                pane_context=pane_context,
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "analyze_error":
        # Analyze a failed command and provide error categorization + fix suggestions
        command = params.get("command", "")
        output = params.get("output", "")
        exit_code = params.get("exit_code")
        cwd = params.get("cwd", "/")
        profile = params.get("profile", "default")
        pane_context = params.get("pane_context", "")
        if not command or exit_code is None:
            return {
                "id": req_id,
                "type": "error",
                "message": "analyze_error requires 'command' and 'exit_code' parameters"
            }
        try:
            intelligence = command_intelligence.get_instance()
            result = intelligence.analyze_error(
                command=command,
                output=output,
                exit_code=exit_code,
                cwd=cwd,
                profile=profile,
                pane_context=pane_context,
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "parse.request":
        # Parse raw CLI output via Genie (primary) / TextFSM (fallback).
        vendor = params.get("vendor")
        platform = params.get("platform")
        command = params.get("command")
        raw = params.get("raw")
        if not (
            isinstance(vendor, str) and vendor
            and isinstance(platform, str) and platform
            and isinstance(command, str) and command
            and isinstance(raw, str)
        ):
            return {
                "id": req_id,
                "type": "error",
                "message": "parse.request requires 'vendor', 'platform', 'command', 'raw' params",
            }
        try:
            from ccie_sidecar.parsers.dispatcher import parse_show
            from ccie_sidecar.parsers.errors import NoParserError

            result = parse_show(vendor, platform, command, raw)
            return {"id": req_id, "type": "done", "result": result}
        except NoParserError as e:
            return {"id": req_id, "type": "error", "message": str(e)}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "topology.neighbors":
        # Plan 13 Phase 1 — call parse_show then normalize the envelope into
        # a flat list of NeighborRecord dicts. Phase 5 Task 5.2 extended the
        # accepted protocol set to cover routing adjacencies.
        protocol = params.get("protocol")
        vendor = params.get("vendor")
        platform = params.get("platform")
        command = params.get("command")
        raw = params.get("raw")
        if protocol not in ("cdp", "lldp", "bgp", "ospf", "isis"):
            return {
                "id": req_id,
                "type": "error",
                "message": (
                    "topology.neighbors 'protocol' must be one of "
                    "'cdp', 'lldp', 'bgp', 'ospf', 'isis'"
                ),
            }
        if not (
            isinstance(vendor, str) and vendor
            and isinstance(platform, str) and platform
            and isinstance(command, str) and command
            and isinstance(raw, str)
        ):
            return {
                "id": req_id,
                "type": "error",
                "message": "topology.neighbors requires 'vendor', 'platform', 'command', 'raw' params",
            }
        try:
            from ccie_sidecar.parsers.dispatcher import parse_show
            from ccie_sidecar.parsers.errors import NoParserError
            from ccie_sidecar.topology.neighbors import normalize_neighbors

            envelope = parse_show(vendor, platform, command, raw)
            records = normalize_neighbors(protocol, envelope)
            return {
                "id": req_id,
                "type": "done",
                "result": {"records": records},
            }
        except NoParserError as e:
            return {"id": req_id, "type": "error", "message": str(e)}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "iac.classify_blast_radius":
        # IaC Phase 2 — single source of truth for blast-radius thresholds lives
        # in Python (the sidecar cannot call back into Rust). This RPC lets the
        # Rust/terminal side reuse the same classifier for any future UI.
        tool = params.get("tool", "terraform")
        working_dir = params.get("working_dir", "")
        git_branch = params.get("git_branch", "")
        plan_output = params.get("plan_output")
        if not isinstance(working_dir, str) or not working_dir:
            return {
                "id": req_id,
                "type": "error",
                "message": "iac.classify_blast_radius requires a 'working_dir' string",
            }
        try:
            from ccie_sidecar.agents.iac_blast_radius import classify_iac

            result = classify_iac(
                tool=tool,
                working_dir=working_dir,
                git_branch=git_branch,
                plan_output=plan_output,
                has_destructive_tag=bool(params.get("has_destructive_tag", False)),
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "iac.analyze_drift":
        # IaC Phase 3 — best-effort AI explanation of detected drift. Rust has
        # already detected the drift; this only adds prose. Never fatal: the
        # analyzer itself degrades to {"analyses": [], "unavailable": True}.
        drifted = params.get("drifted")
        if not isinstance(drifted, list):
            return {
                "id": req_id,
                "type": "error",
                "message": "iac.analyze_drift requires a 'drifted' list",
            }
        plan_output = params.get("plan_output", "") or ""
        try:
            from ccie_sidecar.agents import iac_drift_analysis

            result = iac_drift_analysis.analyze_drift(drifted, plan_output=plan_output)
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:  # pragma: no cover — analyzer already guards
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "architect.keyword_defaults":
        # Settings → Vendor Keywords tab: the built-in routing keyword defaults
        # (single source of truth lives in Python). The tab merges these with the
        # saved override for display. Read-only; never fatal.
        try:
            from ccie_sidecar.agents.architect_subagents import keyword_defaults_payload
            return {"id": req_id, "type": "done", "result": keyword_defaults_payload()}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "proxmox.test_connection":
        # Settings → Proxmox "Test connection" button. Tests the passed-in config
        # (not the saved one) with a single read-only get_nodes call. Never saves,
        # never mutates the server. Always returns done with {ok, message}.
        conf = params.get("config") or {}
        from ccie_sidecar.proxmox_api.connection import test_connection as _pve_test
        return {"id": req_id, "type": "done", "result": _pve_test(conf)}

    elif method in {"agent_computer.health", "agent_computer.provision", "agent_computer.start_lxc", "agent_computer.stop_lxc"}:
        computer = params.get("computer") or {}
        node = computer.get("node", "")
        vmid = computer.get("vmid", "")
        if not node or not vmid:
            return {"id": req_id, "type": "done", "result": {"ok": False, "message": "Agent computer needs node and vmid."}}
        proxmox_config_key = "proxmoxConfig" if "proxmoxConfig" in params else "proxmox_config" if "proxmox_config" in params else None
        proxmox_config = params.get(proxmox_config_key) if proxmox_config_key else None
        if method == "agent_computer.health":
            from ccie_sidecar.agent_computer import ComputerFacade
            kwargs = {"proxmox_config_loader": lambda: proxmox_config} if proxmox_config_key else {}
            result = ComputerFacade(config_loader=lambda: [computer], **kwargs).health(computer.get("name") or "")
            return {"id": req_id, "type": "done", "result": {"ok": bool(result.get("ok")), "message": result.get("hostname") or result.get("error") or "OK"}}
        from ccie_sidecar.proxmox_api.facade import ProxmoxFacade
        facade = ProxmoxFacade(config_loader=lambda: proxmox_config) if proxmox_config_key else ProxmoxFacade()
        if method == "agent_computer.provision":
            template_vmid = computer.get("templateVmid") or computer.get("template_vmid") or ""
            if not template_vmid:
                return {"id": req_id, "type": "done", "result": {"ok": False, "message": "Agent computer needs template VMID."}}
            result = facade.clone_container(node, template_vmid, vmid, computer.get("name") or f"agent-{vmid}")
            if result.get("ok"):
                start = facade.start_container(node, vmid)
                result = start if not start.get("ok") else result
            generated = {"name": computer.get("name") or f"agent-{vmid}", "node": node, "vmid": vmid, "templateVmid": template_vmid, "baseUrl": f"pct://{node}/{vmid}", "token": computer.get("token") or "pct"}
            ok = bool(result.get("ok"))
            return {"id": req_id, "type": "done", "result": {"ok": ok, "message": "Provisioned" if ok else result.get("error") or "Provision failed", "computer": generated}}
        result = facade.start_container(node, vmid) if method.endswith("start_lxc") else facade.stop_container(node, vmid)
        return {"id": req_id, "type": "done", "result": {"ok": bool(result.get("ok")), "message": result.get("upid") or result.get("error") or "OK"}}

    elif method == "stealthwatch.test_connection":
        # Settings → Stealthwatch "Test connection" button. Tests the passed-in config
        # (not the saved one) with a single read-only API call. Never saves,
        # never mutates the server. Always returns done with {ok, message}.
        conf = params.get("config") or {}
        from ccie_sidecar.stealthwatch import test_connection as _sw_test
        return {"id": req_id, "type": "done", "result": _sw_test(conf)}

    elif method == "ise.test_connection":
        # Settings → ISE "Test connection" button. Tests the passed-in config
        # (not the saved one) with a single read-only ERS call. Never saves,
        # never mutates the server. Always returns done with {ok, message}.
        conf = params.get("config") or {}
        from ccie_sidecar.ise import test_connection as _ise_test
        return {"id": req_id, "type": "done", "result": _ise_test(conf)}

    elif method == "secure_endpoint.test_connection":
        # Settings → Secure Endpoint "Test connection" button. Tests the passed-in
        # config with a single read-only GET /v1/version. Never saves, never mutates.
        conf = params.get("config") or {}
        from ccie_sidecar.secure_endpoint import test_connection as _se_test
        return {"id": req_id, "type": "done", "result": _se_test(conf)}

    elif method == "cisco_xdr.test_connection":
        # Settings → Cisco XDR "Test connection" button. Tests the passed-in
        # config by minting an OAuth2 client_credentials token. Never saves.
        conf = params.get("config") or {}
        from ccie_sidecar.cisco_xdr import test_connection as _xdr_test
        return {"id": req_id, "type": "done", "result": _xdr_test(conf)}

    elif method == "mist.test_connection":
        # Settings → Juniper Mist "Test connection" button. Tests the passed-in
        # config with a single read-only GET /api/v1/self. Never saves.
        conf = params.get("config") or {}
        from ccie_sidecar.mist import test_connection as _mist_test
        return {"id": req_id, "type": "done", "result": _mist_test(conf)}

    elif method == "cml.test_connection":
        # Settings → CML "Test connection" button. Tests the passed-in config
        # (not the saved one) with a single read-only /labs call after auth.
        # Never saves, never mutates the server. Always returns done with {ok, message}.
        conf = params.get("config") or {}
        from ccie_sidecar.cml import test_connection as _cml_test
        return {"id": req_id, "type": "done", "result": _cml_test(conf)}

    elif method == "gnmi.test_connection":
        # Settings → gNMI "Test connection" button. Runs a read-only capabilities
        # request against the first configured target. Never mutates. Always
        # returns done with {ok, message}.
        conf = params.get("config") or {}
        from ccie_sidecar.gnmi import test_connection as _gnmi_test
        return {"id": req_id, "type": "done", "result": _gnmi_test(conf)}

    elif method == "meraki.test_connection":
        # Settings → Meraki "Test connection" button. Tests the passed-in API key
        # with a single read-only getOrganizations call. Never saves. Always
        # returns done with {ok, message}.
        conf = params.get("config") or {}
        from ccie_sidecar.meraki import test_connection as _meraki_test
        return {"id": req_id, "type": "done", "result": _meraki_test(conf)}

    elif method == "fmc.test_connection":
        # Settings → FMC "Test connection" button. Tests the passed-in config
        # (not the saved one) with a single read-only devicerecords call after
        # token auth. Never saves, never mutates. Always returns done with {ok, message}.
        conf = params.get("config") or {}
        from ccie_sidecar.fmc import test_connection as _fmc_test
        return {"id": req_id, "type": "done", "result": _fmc_test(conf)}

    elif method == "thousandeyes.test_connection":
        # Settings → ThousandEyes "Test connection" button. Tests the passed-in
        # token with a single read-only /v7/account-groups call. Never saves.
        # Always returns done with {ok, message}.
        conf = params.get("config") or {}
        from ccie_sidecar.thousandeyes import test_connection as _te_test
        return {"id": req_id, "type": "done", "result": _te_test(conf)}

    elif method == "aci.test_connection":
        # Settings → ACI "Test connection" button. Tests the passed-in config
        # (not the saved one) with a single read-only topSystem class query after
        # login. Never saves, never mutates the fabric. Always returns done with {ok, message}.
        conf = params.get("config") or {}
        from ccie_sidecar.aci import test_connection as _aci_test
        return {"id": req_id, "type": "done", "result": _aci_test(conf)}

    elif method == "catalyst_center.test_connection":
        # Settings → Catalyst Center "Test connection" button. Tests the passed-in
        # config (not the saved one) with a single read-only device-count call after
        # auth. Never saves, never mutates the server. Always returns done with {ok, message}.
        conf = params.get("config") or {}
        from ccie_sidecar.catalyst_center import test_connection as _cc_test
        return {"id": req_id, "type": "done", "result": _cc_test(conf)}

    elif method == "splunk.test_connection":
        # Settings → Splunk "Test connection" button. Tests the passed-in config
        # (not the saved one) with a single read-only /services/server/info call.
        # Never saves, never mutates. Always returns done with {ok, message}.
        conf = params.get("config") or {}
        from ccie_sidecar.splunk import test_connection as _splunk_test
        return {"id": req_id, "type": "done", "result": _splunk_test(conf)}

    elif method == "grafana.test_connection":
        # Settings → Grafana "Test connection" button. Read-only /api/health + a
        # cheap authed /api/user read. Never saves.
        conf = params.get("config") or {}
        from ccie_sidecar.grafana import test_connection as _grafana_test
        return {"id": req_id, "type": "done", "result": _grafana_test(conf)}
    elif method == "zabbix.test_connection":
        from ccie_sidecar.zabbix import test_connection as _zabbix_test
        return {"id": req_id, "type": "done", "result": _zabbix_test(params.get("config") or {})}

    elif method == "prometheus.test_connection":
        # Settings → Prometheus "Test connection" button. A trivial `up` instant
        # query confirms URL + auth. Never saves.
        conf = params.get("config") or {}
        from ccie_sidecar.prometheus import test_connection as _prom_test
        return {"id": req_id, "type": "done", "result": _prom_test(conf)}

    elif method == "netbox.test_connection":
        # Settings → NetBox "Test connection" button. Read-only /api/status/ call
        # confirms URL + token. Never saves, never mutates.
        conf = params.get("config") or {}
        from ccie_sidecar.netbox import test_connection as _netbox_test
        return {"id": req_id, "type": "done", "result": _netbox_test(conf)}

    elif method == "sketchfab.test_connection":
        # Settings → Sketchfab "Test connection" button. Keyed test validates via
        # /v3/me; unkeyed test just confirms the public API answers a search.
        conf = params.get("config") or {}
        from ccie_sidecar.sketchfab import test_connection as _sf_test
        return {"id": req_id, "type": "done", "result": _sf_test(conf)}

    elif method == "iac.lint_file":
        # IaC Studio Phase B — lint a single buffer with the real CLI linters
        # (terraform fmt/validate, ansible-lint/--syntax-check). The linter is
        # honest: every linter reports whether it ran and why not. Never fatal.
        file_path = params.get("file_path")
        content = params.get("content")
        language = params.get("language", "")
        if not isinstance(file_path, str) or content is None:
            return {
                "id": req_id,
                "type": "error",
                "message": "iac.lint_file requires 'file_path' (str) and 'content'",
            }
        try:
            from ccie_sidecar.agents import iac_lint

            result = iac_lint.lint_file(
                file_path=file_path, content=content, language=language
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:  # pragma: no cover — lint_file already guards
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "iac.generate_terraform_code":
        # IaC Studio Phase C — NL → Terraform HCL using the Settings-page LLM.
        # codegen never raises; a failed/missing model returns
        # {"unavailable": True, "code": ""} (honest, never a fake clean result).
        intent = params.get("intent")
        working_dir = params.get("working_dir", "")
        if not isinstance(intent, str) or not intent.strip():
            return {
                "id": req_id,
                "type": "error",
                "message": "iac.generate_terraform_code requires an 'intent' string",
            }
        try:
            from ccie_sidecar.agents import iac_codegen, iac_codegen_tools

            llm = iac_codegen_tools.build_default_codegen_llm()
            context = {
                "project_path": working_dir,
                "git_branch": params.get("git_branch", ""),
                "existing_resources": params.get("existing_code", ""),
            }
            result = iac_codegen.generate_terraform_code(intent, context, llm=llm)
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:  # pragma: no cover — codegen already guards
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "iac.generate_ansible_playbook":
        # IaC Studio Phase C — NL → Ansible YAML using the Settings-page LLM.
        intent = params.get("intent")
        working_dir = params.get("working_dir", "")
        if not isinstance(intent, str) or not intent.strip():
            return {
                "id": req_id,
                "type": "error",
                "message": "iac.generate_ansible_playbook requires an 'intent' string",
            }
        try:
            from ccie_sidecar.agents import iac_codegen, iac_codegen_tools

            llm = iac_codegen_tools.build_default_codegen_llm()
            context = {
                "project_path": working_dir,
                "git_branch": params.get("git_branch", ""),
                "roles_path": working_dir,
                # The file the user has open — when present, codegen EDITS it
                # (returns the full updated playbook) instead of starting fresh.
                "existing_code": params.get("existing_code", ""),
            }
            result = iac_codegen.generate_ansible_playbook(intent, context, llm=llm)
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:  # pragma: no cover — codegen already guards
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "heartbeat.plan":
        # Heartbeat Monitoring — convert natural language to structured check plan.
        # Used by CreateHeartbeatModal Stage 1 → 2 transition.
        nl_input = params.get("nl_input")
        context = params.get("context", {})
        if not isinstance(nl_input, str) or not nl_input.strip():
            return {
                "id": req_id,
                "type": "error",
                "message": "heartbeat.plan requires 'nl_input' string",
            }
        try:
            from ccie_sidecar.agents.heartbeat_planner import plan_heartbeat

            plan_result = plan_heartbeat(nl_input, context)
            # plan_heartbeat returns {"status": "success", "plan": {...}}
            # Extract the plan and wrap it as the result
            if plan_result.get("status") == "success":
                return {"id": req_id, "type": "done", "result": plan_result["plan"]}
            else:
                return {
                    "id": req_id,
                    "type": "error",
                    "message": plan_result.get("message", "Failed to generate plan")
                }
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "heartbeat.execute_check":
        # Heartbeat Monitoring — execute a single heartbeat check by running an agent.
        # Called by Rust heartbeat executor for each scheduled check.
        agent_id = params.get("agent_id")
        prompt = params.get("prompt")
        check_id = params.get("check_id")
        if not isinstance(agent_id, str) or not agent_id:
            return {
                "id": req_id,
                "type": "error",
                "message": "heartbeat.execute_check requires 'agent_id' string",
            }
        if not isinstance(prompt, str) or not prompt:
            return {
                "id": req_id,
                "type": "error",
                "message": "heartbeat.execute_check requires 'prompt' string",
            }
        try:
            from ccie_sidecar.agents.heartbeat_executor import execute_check

            result = execute_check(agent_id, prompt, check_id or "unknown")
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:
            return {"id": req_id, "type": "error", "message": str(e)}

    elif method == "iac.generate_pipeline":
        # IaC Studio Phase D — NL → CI/CD pipeline YAML (GitHub Actions / GitLab
        # CI). Validated as plain YAML, never as HCL/playbook. Uses the
        # Settings-page LLM; an unavailable model returns {"unavailable": True}.
        platform = params.get("platform")
        if platform not in ("github", "gitlab"):
            return {
                "id": req_id,
                "type": "error",
                "message": "iac.generate_pipeline requires 'platform' of 'github' or 'gitlab'",
            }
        try:
            from ccie_sidecar.agents import iac_codegen, iac_codegen_tools

            llm = iac_codegen_tools.build_default_codegen_llm()
            context = {
                "platform": platform,
                "tool": params.get("tool", "terraform"),
                "flow": params.get("flow", "plan on PR, apply on merge"),
                "auth": params.get("auth", ""),
            }
            result = iac_codegen.generate_pipeline(
                params.get("intent", ""), context, llm=llm
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:  # pragma: no cover — codegen already guards
            return {"id": req_id, "type": "error", "message": str(e)}

    if method == "pcap.run_capture":
        # Plan 11 — run a live capture lifecycle in ONE persistent session via
        # pyATS/unicon. IOS-XE EPC ties the capture to the session that started
        # it, so the setup→start→wait→stop→export sequence must stay in a single
        # session (one-shot `ssh host "cmd"` tears the capture down on close).
        # Leaves the .pcap on the device's flash; Rust pulls it over SCP.
        required = ("host", "username", "password", "interface", "duration_s")
        missing = [k for k in required if params.get(k) in (None, "")]
        if missing:
            return {
                "id": req_id,
                "type": "error",
                "message": f"pcap.run_capture missing params: {', '.join(missing)}",
            }
        try:
            from ccie_sidecar.pcap_capture import run_capture

            result = run_capture(
                host=params["host"],
                username=params["username"],
                password=params["password"],
                interface=params["interface"],
                duration_s=int(params["duration_s"]),
                device_kind=params.get("device_kind", "iosxe"),
                acl=params.get("acl") or None,
                buffer_mb=int(params.get("buffer_mb", 10)),
                capture_name=params.get("capture_name", "CAP"),
                port=int(params.get("port", 22)),
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as e:  # pragma: no cover — run_capture already guards
            return {"id": req_id, "type": "error", "message": str(e)}

    if method == "pcap.finding_rules":
        try:
            from ccie_sidecar.parsers.pcap import finding_rules

            return {"id": req_id, "type": "done", "result": finding_rules()}
        except Exception as exc:  # pragma: no cover - import/runtime packaging
            return {"id": req_id, "type": "error", "message": str(exc)}

    if method in (
        "pcap.summarize",
        "pcap.follow_stream",
        "pcap.packet_bytes",
        "pcap.findings",
    ):
        # Plan 11 — pcap inspection. All methods load a pcap on disk and
        # return either a structured payload (`done`) or a `pcap.error`
        # with a stable code that the UI can branch on.
        path = params.get("path")
        if not isinstance(path, str) or not path:
            return {
                "id": req_id,
                "type": "error",
                "message": f"{method} requires a 'path' string",
            }
        try:
            from ccie_sidecar.parsers.pcap import (
                PcapInvalidFilterError,
                PcapInvalidFindingRulesError,
                PcapUnsupportedFindingFilterError,
                follow_stream,
                pcap_findings,
                packet_bytes,
                summarize_pcap,
            )
        except Exception as exc:  # pragma: no cover
            return {"id": req_id, "type": "error", "message": str(exc)}
        try:
            if method == "pcap.summarize":
                max_packets = int(params.get("max_packets", 200))
                display_filter = params.get("display_filter")
                if display_filter is not None and not isinstance(display_filter, str):
                    return {
                        "id": req_id,
                        "type": "error",
                        "message": "pcap.summarize 'display_filter' must be a string",
                    }
                result = summarize_pcap(path, max_packets, display_filter or None)
            elif method == "pcap.packet_bytes":
                index = int(params.get("index", 0))
                if index < 1:
                    return {
                        "id": req_id,
                        "type": "error",
                        "message": "pcap.packet_bytes 'index' must be >= 1",
                    }
                result = packet_bytes(path, index)
            elif method == "pcap.follow_stream":
                stream_index = int(params.get("stream_index", 0))
                result = follow_stream(path, stream_index)
            else:  # pcap.findings
                enabled = params.get("enabled_rule_ids")
                if enabled is not None and (
                    not isinstance(enabled, list)
                    or not all(isinstance(rule_id, str) for rule_id in enabled)
                ):
                    return {
                        "id": req_id,
                        "type": "error",
                        "message": "pcap.findings 'enabled_rule_ids' must be a string array",
                    }
                result = pcap_findings(path, enabled)
            return {"id": req_id, "type": "done", "result": result}
        except FileNotFoundError as exc:
            return {
                "id": req_id,
                "type": "error",
                "message": f"file_not_found: {exc}",
            }
        except PcapInvalidFilterError as exc:
            return {
                "id": req_id,
                "type": "error",
                "message": f"invalid_filter: {exc}",
            }
        except PcapUnsupportedFindingFilterError as exc:
            return {
                "id": req_id,
                "type": "error",
                "message": f"unsupported_filter: {exc}",
            }
        except PcapInvalidFindingRulesError as exc:
            return {
                "id": req_id,
                "type": "error",
                "message": f"invalid_rules: {exc}",
            }
        except IndexError as exc:
            return {
                "id": req_id,
                "type": "error",
                "message": f"out_of_range: {exc}",
            }
        except Exception as exc:
            return {"id": req_id, "type": "error", "message": str(exc)}

    if method == "rag.ingest":
        # Plan 12 Phase 2 — extract a document, chunk it, embed each chunk
        # via the bundled MiniLM-L6 model, and stream progress back to the
        # caller. Validation runs synchronously so malformed requests get a
        # plain `error` response instead of opening a streaming connection.
        path = params.get("path")
        kind = params.get("kind")
        title = params.get("title")
        if not isinstance(path, str) or not path:
            return {
                "id": req_id,
                "type": "error",
                "message": "rag.ingest requires a non-empty 'path' string",
            }
        if not isinstance(kind, str) or kind not in {"pdf", "html", "md", "txt"}:
            return {
                "id": req_id,
                "type": "error",
                "message": "rag.ingest 'kind' must be one of pdf|html|md|txt",
            }
        if not isinstance(title, str) or not title:
            return {
                "id": req_id,
                "type": "error",
                "message": "rag.ingest requires a non-empty 'title' string",
            }
        return {"id": req_id, "type": "stream", "method": method, "params": params}

    if method == "rag.embed":
        # Plan 12 Phase 4 — query-time embedder. Non-streaming: one
        # round-trip producing a single 384-dim L2-normalized vector.
        # Same model + tokenizer as `rag.ingest`, so retrieval embeddings
        # share the index space the chunks were written into.
        text = params.get("text")
        if not isinstance(text, str) or not text:
            return {
                "id": req_id,
                "type": "error",
                "message": "rag.embed requires a non-empty 'text' string",
            }
        try:
            from ccie_sidecar.rag.embed import Embedder

            emb = Embedder.get()
            vec = emb.embed_one(text)
            return {
                "id": req_id,
                "type": "done",
                "result": {"embedding": vec.tolist()},
            }
        except Exception as exc:  # pragma: no cover — surfaces as Sidecar error
            return {"id": req_id, "type": "error", "message": str(exc)}

    if method == "guardrail.classify":
        # Plan 09 Phase 5 — second-opinion classifier invoked by Rust when
        # the rule engine returned Ambiguous. Rust treats this only as a
        # tier-RAISING overlay (see ambiguity::merge), so a wrong "low"
        # answer can never auto-approve.
        vendor = params.get("vendor", "")
        platform = params.get("platform", "")
        command = params.get("command", "")
        if not isinstance(command, str) or not command:
            return {
                "id": req_id,
                "type": "error",
                "message": "guardrail.classify requires a non-empty 'command' string",
            }
        try:
            from ccie_sidecar.guardrail_classifier import classify as _gr_classify

            result = _gr_classify(
                vendor if isinstance(vendor, str) else "",
                platform if isinstance(platform, str) else "",
                command,
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as exc:
            return {"id": req_id, "type": "error", "message": str(exc)}

    if method == "troubleshoot.narrate":
        # Plan 15 Phase 3 — per-step narration. Synchronous (we call the
        # async function via asyncio.run since the server loop is sync).
        # The handler is intentionally lenient: a missing LLM key, a
        # broken RAG client, or a malformed step all degrade to an empty
        # text so the Rust executor can fall back to the literal
        # playbook text.
        step = params.get("step") or {}
        parsed = params.get("parsed")
        vars_ = params.get("vars") or {}
        vendor = params.get("vendor") or ""
        platform = params.get("platform") or ""
        # Phase 2's executor sends `step_id` + `text` directly (not the
        # whole step dict). Accept both shapes so callers don't need to
        # reshape.
        if not step and ("step_id" in params or "text" in params):
            step = {
                "id": params.get("step_id", ""),
                "type": params.get("step_type", "narration"),
                "text": params.get("text", ""),
                "command": params.get("command", ""),
            }
            if not parsed:
                parsed = params.get("last_parsed")
        try:
            import asyncio

            from ccie_sidecar.troubleshoot.narrator import narrate as _narrate

            result = asyncio.run(
                _narrate(step, parsed, vars_, vendor, platform)
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as exc:
            # Belt-and-braces: never let a narration error abort the
            # engine. Return an empty payload; Rust falls back to the
            # literal text.
            return {
                "id": req_id,
                "type": "done",
                "result": {"text": "", "citations": [], "_warning": str(exc)},
            }

    if method == "troubleshoot.match_symptom":
        # Plan 15 Phase 5 — symptom-to-playbook matcher. Synchronous
        # (we call the async matcher via asyncio.run since the server
        # loop is sync). Threshold enforcement lives in the UI; this
        # handler always returns the top-5 ranked candidates.
        symptom = params.get("symptom") or ""
        vendor = params.get("vendor")
        platform = params.get("platform")
        playbooks = params.get("playbooks") or []
        if not isinstance(symptom, str):
            return {
                "id": req_id,
                "type": "error",
                "message": "troubleshoot.match_symptom 'symptom' must be a string",
            }
        if not isinstance(playbooks, list):
            return {
                "id": req_id,
                "type": "error",
                "message": "troubleshoot.match_symptom 'playbooks' must be a list",
            }
        # Vendor / platform may be null in the request — coerce to None
        # so the matcher's "any" path runs.
        vendor = vendor if isinstance(vendor, str) and vendor else None
        platform = platform if isinstance(platform, str) and platform else None
        try:
            import asyncio

            from ccie_sidecar.troubleshoot.matcher import match_symptom as _match

            matches = asyncio.run(_match(symptom, vendor, platform, playbooks))
            return {
                "id": req_id,
                "type": "done",
                "result": {"matches": matches},
            }
        except Exception as exc:
            return {"id": req_id, "type": "error", "message": str(exc)}

    if method == "troubleshoot.conclude":
        # Plan 15 Phase 3 — run conclusion. Always returns the four
        # required fields (root_cause / confidence / suggested_fix /
        # evidence) thanks to `_coerce_conclusion` defensive defaults.
        run_history = params.get("run_history") or []
        symptom = params.get("symptom") or ""
        vendor = params.get("vendor") or ""
        platform = params.get("platform") or ""
        if not isinstance(run_history, list):
            return {
                "id": req_id,
                "type": "error",
                "message": "troubleshoot.conclude 'run_history' must be a list",
            }
        try:
            import asyncio

            from ccie_sidecar.troubleshoot.narrator import conclude as _conclude

            result = asyncio.run(
                _conclude(run_history, symptom, vendor, platform)
            )
            return {"id": req_id, "type": "done", "result": result}
        except Exception as exc:
            return {"id": req_id, "type": "error", "message": str(exc)}

    if method == "troubleshoot.generate_playbook":
        # Playbook editor "Generate with AI" — author a schema-valid
        # playbook YAML from a free-form symptom using the Settings-page
        # LLM. Returns {"yaml": str, "error": str | None}.
        symptom = params.get("symptom") or ""
        vendor = params.get("vendor")
        platform = params.get("platform")
        if not isinstance(symptom, str) or not symptom.strip():
            return {
                "id": req_id,
                "type": "error",
                "message": "troubleshoot.generate_playbook requires a 'symptom' string",
            }
        try:
            from ccie_sidecar.troubleshoot.generator import (
                generate_playbook as _gen_playbook,
            )

            result = _gen_playbook(symptom, vendor, platform)
            return {"id": req_id, "type": "done", "result": result}
        except Exception as exc:
            return {"id": req_id, "type": "error", "message": str(exc)}

    if method == "api_hook.call":
        # API Runner auth hook dispatch.
        module_name = params.get("module")
        function_name = params.get("function")
        request_dict = params.get("request")
        env = params.get("env", {})
        if not isinstance(module_name, str) or not isinstance(function_name, str):
            return {
                "id": req_id,
                "type": "error",
                "message": "api_hook.call requires string 'module' and 'function'",
            }
        if not isinstance(request_dict, dict):
            return {
                "id": req_id,
                "type": "error",
                "message": "api_hook.call requires dict 'request'",
            }
        try:
            from ccie_sidecar.api_hook_runner import call_hook

            result = call_hook(module_name, function_name, request_dict, env)
            return {"id": req_id, "type": "done", "result": result}
        except Exception as exc:
            return {"id": req_id, "type": "error", "message": str(exc)}

    if method == "agent.react_loop":
        # ReACT agent execution - streaming method
        agent_id = params.get("agent_id")
        message = params.get("message")
        system_prompt = params.get("system_prompt")
        tools = params.get("tools")
        vault_entry = params.get("vault_entry")

        if not agent_id or not message:
            return {
                "id": req_id,
                "type": "error",
                "message": "agent.react_loop requires 'agent_id' and 'message' parameters"
            }

        return {"id": req_id, "type": "stream", "method": method, "params": params}

    if method == "agent.code_exec_loop":
        # Code execution agent loop - streaming method
        agent_id = params.get("agent_id")
        message = params.get("message")
        system_prompt = params.get("system_prompt")
        tool_id = params.get("tool_id")
        catalog_path = params.get("catalog_path")
        vault_entry = params.get("vault_entry")

        if not agent_id or not message:
            return {
                "id": req_id,
                "type": "error",
                "message": "agent.code_exec_loop requires 'agent_id' and 'message' parameters"
            }

        return {"id": req_id, "type": "stream", "method": method, "params": params}

    if method == "agent.react_code_loop":
        # ReACT loop with code execution as tool - streaming method
        agent_id = params.get("agent_id")
        message = params.get("message")

        if not agent_id or not message:
            return {
                "id": req_id,
                "type": "error",
                "message": "agent.react_code_loop requires 'agent_id' and 'message' parameters"
            }

        terminal_context = params.get("terminal_context")
        if terminal_context is not None and agent_id != "network-architect":
            return {
                "id": req_id,
                "type": "error",
                "message": "terminal_context is restricted to network-architect",
            }

        return {"id": req_id, "type": "stream", "method": method, "params": params}

    if method == "agent.react_resume":
        # Resume an interrupted DeepAgents execution (HITL approval round-trip).
        # Streaming method: run_loop drives it and re-streams the resumed graph's
        # events. Without this branch the request fell through to "unknown method"
        # and run_loop's resume handler was unreachable.
        thread_id = params.get("thread_id")
        decision = params.get("decision")

        if not thread_id:
            return {
                "id": req_id,
                "type": "error",
                "message": "agent.react_resume requires 'thread_id' parameter",
            }
        if not decision:
            return {
                "id": req_id,
                "type": "error",
                "message": "agent.react_resume requires 'decision' parameter (approve|deny|edit)",
            }
        if decision not in {"approve", "deny", "edit", "continue"}:
            return {
                "id": req_id,
                "type": "error",
                "message": "agent.react_resume decision must be approve, deny, edit, or continue",
            }
        if decision == "edit" and not isinstance(params.get("edited_action"), dict):
            return {
                "id": req_id,
                "type": "error",
                "message": "agent.react_resume edit requires edited_action",
            }

        return {"id": req_id, "type": "stream", "method": method, "params": params}

    return {"id": req_id, "type": "error", "message": f"unknown method: {method!r}"}


class _LockedStdout:
    """TextIO wrapper that serializes writes across threads.

    The heartbeat thread (see `_start_heartbeat`) and the request handler
    thread both write NDJSON lines. Without a lock their bytes can interleave
    and corrupt output.
    """

    def __init__(self, inner: TextIO, lock: threading.Lock):
        self._inner = inner
        self._lock = lock

    def write(self, s: str) -> int:  # type: ignore[override]
        with self._lock:
            return self._inner.write(s)

    def flush(self) -> None:  # type: ignore[override]
        with self._lock:
            self._inner.flush()

    def __getattr__(self, name):
        return getattr(self._inner, name)


def run_loop(stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
    # Initialize command intelligence singleton
    command_intelligence.initialize()

    # Wrap stdout in a lock so the heartbeat thread can't interleave with the
    # request handler's NDJSON writes.
    stdout = _LockedStdout(stdout, _STDOUT_LOCK)

    # Export the static vendor-keyword defaults to a file so the Settings tab can
    # read them without an RPC. The request loop below is single-threaded, so a
    # long agent turn would otherwise block a mid-turn defaults RPC — writing the
    # file here (before the loop) sidesteps that entirely. Done BEFORE starting
    # the heartbeat: this pulls in a heavy import, and doing it after the heartbeat
    # thread starts would let the first beat race ahead of the first response.
    # Best-effort; touches only a file, never stdout.
    try:
        from ccie_sidecar.agents.architect_subagents import (
            write_vendor_keyword_defaults_file,
        )
        write_vendor_keyword_defaults_file()
    except Exception:
        pass

    # Start the heartbeat emitter. The thread is a daemon so it exits when the
    # main run_loop returns.
    _start_heartbeat(stdout)

    # If WhatsApp is enabled and already linked, reconnect the client at boot so
    # the operator doesn't have to re-scan after an app restart. Best-effort;
    # never touches stdout and never blocks the loop (runs on its own thread).
    try:
        from ccie_sidecar.whatsapp_bridge import maybe_autostart

        maybe_autostart()
    except Exception:
        pass

    for line in stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as e:
            err = {"id": "", "type": "error", "message": f"invalid json: {e}"}
            stdout.write(json.dumps(err) + "\n")
            stdout.flush()
            continue

        resp = handle_request(req)
        req_id = str(req.get("id", ""))

        # Handle streaming methods
        if resp.get("type") == "stream":
            method = resp.get("method")
            params = resp.get("params", {})

            if method == "chat.stream":
                session_id = params.get("session_id")
                messages = params.get("messages")
                profile = params.get("profile", "default")
                try:
                    for event in chat_stream(session_id=session_id, messages=messages, profile=profile):
                        stream_msg = {"id": req_id, **event}
                        stdout.write(json.dumps(stream_msg) + "\n")
                        stdout.flush()
                    # Send done event
                    done_msg = {"id": req_id, "type": "done"}
                    stdout.write(json.dumps(done_msg) + "\n")
                    stdout.flush()
                except Exception as e:
                    err_msg = {"id": req_id, "type": "error", "message": str(e)}
                    stdout.write(json.dumps(err_msg) + "\n")
                    stdout.flush()

            elif method == "chat.stream_agent":
                session_id = params.get("session_id")
                messages = params.get("messages")
                agent_id = params.get("agent_id")
                try:
                    for event in chat_stream_with_agent(
                        session_id=session_id, messages=messages, agent_id=agent_id
                    ):
                        stream_msg = {"id": req_id, **event}
                        stdout.write(json.dumps(stream_msg) + "\n")
                        stdout.flush()
                    done_msg = {"id": req_id, "type": "done"}
                    stdout.write(json.dumps(done_msg) + "\n")
                    stdout.flush()
                except Exception as e:
                    err_msg = {"id": req_id, "type": "error", "message": str(e)}
                    stdout.write(json.dumps(err_msg) + "\n")
                    stdout.flush()

            elif method == "explain_error":
                cmd = params.get("cmd")
                output = params.get("output")
                exit_code = params.get("exit_code")
                cwd = params.get("cwd", "")
                profile = params.get("profile", "default")
                try:
                    # Accumulate response to parse explanation and suggested command
                    accumulated_text = ""
                    for event in explain_error_stream(
                        cmd=cmd, output=output, exit_code=exit_code, cwd=cwd, profile=profile
                    ):
                        if event.get("type") == "token":
                            accumulated_text += event.get("data", "")
                        elif event.get("type") == "error":
                            raise Exception(event.get("message", "Unknown error"))

                    # Parse the response to extract explanation and suggested command
                    explanation_text = accumulated_text.strip()
                    suggested_command = ""

                    # Try to extract suggested command from markdown code blocks
                    code_block_match = re.search(
                        r'```(?:bash|sh|shell)?\s*\n(.*?)\n```',
                        explanation_text,
                        re.DOTALL
                    )
                    if code_block_match:
                        suggested_command = code_block_match.group(1).strip()
                    else:
                        # Look for inline code as fallback
                        inline_code_match = re.search(r'`([^`]+)`', explanation_text)
                        if inline_code_match:
                            suggested_command = inline_code_match.group(1).strip()

                    # Send done event with result
                    result = {
                        "explanation": explanation_text,
                        "suggested_command": suggested_command
                    }
                    done_msg = {"id": req_id, "type": "done", "result": result}
                    stdout.write(json.dumps(done_msg) + "\n")
                    stdout.flush()
                except Exception as e:
                    err_msg = {"id": req_id, "type": "error", "message": str(e)}
                    stdout.write(json.dumps(err_msg) + "\n")
                    stdout.flush()

            elif method == "yang_download":
                vendor = params.get("vendor")
                os_name = params.get("os")
                release = params.get("release")
                cache_base = params.get("cache_base")
                try:
                    from ccie_sidecar.yang_downloader import download_yang_release, index_yang_modules

                    # Stream download progress
                    cache_dir = None
                    for event in download_yang_release(vendor, os_name, release, cache_base):
                        if event["type"] == "done":
                            cache_dir = event["cache_dir"]
                            # Don't send done yet - we need to index first
                        elif event["type"] == "error":
                            err_msg = {"id": req_id, "type": "error", "message": event["message"]}
                            stdout.write(json.dumps(err_msg) + "\n")
                            stdout.flush()
                            break
                        else:
                            # Send progress events
                            progress_msg = {"id": req_id, "type": "progress", "data": event}
                            stdout.write(json.dumps(progress_msg) + "\n")
                            stdout.flush()

                    if cache_dir:
                        # Index modules
                        indexing_msg = {"id": req_id, "type": "progress", "data": {"type": "indexing"}}
                        stdout.write(json.dumps(indexing_msg) + "\n")
                        stdout.flush()

                        modules = index_yang_modules(cache_dir)

                        # Send modules in batches to avoid huge single-line JSON
                        batch_size = 100
                        for i in range(0, len(modules), batch_size):
                            batch = modules[i:i+batch_size]
                            batch_msg = {
                                "id": req_id,
                                "type": "progress",
                                "data": {
                                    "type": "module_batch",
                                    "modules": batch,
                                    "batch_num": i // batch_size + 1,
                                    "total_batches": (len(modules) + batch_size - 1) // batch_size,
                                }
                            }
                            stdout.write(json.dumps(batch_msg) + "\n")
                            stdout.flush()

                        # Send done with just cache_dir and count
                        done_msg = {
                            "id": req_id,
                            "type": "done",
                            "result": {
                                "cache_dir": cache_dir,
                                "module_count": len(modules),
                            },
                        }
                        stdout.write(json.dumps(done_msg) + "\n")
                        stdout.flush()
                except Exception as e:
                    err_msg = {"id": req_id, "type": "error", "message": str(e)}
                    stdout.write(json.dumps(err_msg) + "\n")
                    stdout.flush()
            elif method == "rag.ingest":
                # Lazy imports keep onnxruntime / tokenizers off the
                # sidecar startup path for users who don't use RAG.
                path = params.get("path")
                kind = params.get("kind")
                title = params.get("title")
                try:
                    from ccie_sidecar.rag.chunker import chunk_text
                    from ccie_sidecar.rag.embed import Embedder
                    from ccie_sidecar.rag.extract import extract_text

                    raw = extract_text(path, kind)
                    chunks = chunk_text(raw, target_tokens=512, overlap_tokens=64)
                    total = len(chunks)
                    results: list[dict[str, Any]] = []

                    if total == 0:
                        # Empty doc — emit an empty result so the caller
                        # can mark the source ingested-but-empty.
                        result_msg = {
                            "id": req_id,
                            "type": "rag.ingest.result",
                            "payload": {"title": title, "chunks": []},
                        }
                        stdout.write(json.dumps(result_msg) + "\n")
                        stdout.flush()
                        done_msg = {"id": req_id, "type": "done"}
                        stdout.write(json.dumps(done_msg) + "\n")
                        stdout.flush()
                    else:
                        emb = Embedder.get()
                        BATCH = 16
                        for start in range(0, total, BATCH):
                            batch = chunks[start : start + BATCH]
                            vecs = emb.embed_batch(batch)
                            for i, (t, v) in enumerate(zip(batch, vecs)):
                                results.append(
                                    {
                                        "chunk_idx": start + i,
                                        "text": t,
                                        "embedding": v.tolist(),
                                    }
                                )
                            progress_msg = {
                                "id": req_id,
                                "type": "rag.ingest.progress",
                                "payload": {
                                    "chunks_done": len(results),
                                    "chunks_total": total,
                                },
                            }
                            stdout.write(json.dumps(progress_msg) + "\n")
                            stdout.flush()

                        result_msg = {
                            "id": req_id,
                            "type": "rag.ingest.result",
                            "payload": {"title": title, "chunks": results},
                        }
                        stdout.write(json.dumps(result_msg) + "\n")
                        stdout.flush()
                        done_msg = {"id": req_id, "type": "done"}
                        stdout.write(json.dumps(done_msg) + "\n")
                        stdout.flush()
                except Exception as e:
                    err_msg = {"id": req_id, "type": "error", "message": str(e)}
                    stdout.write(json.dumps(err_msg) + "\n")
                    stdout.flush()

            elif method == "agent.react_loop":
                # ReACT agent execution - streaming method
                import asyncio
                from ccie_sidecar.agents.react import react_loop
                from ccie_sidecar.agent import load_agent, get_saved_config

                agent_id = params.get("agent_id")
                message = params.get("message")
                system_prompt = params.get("system_prompt")
                tools_raw = params.get("tools")
                vault_entry = params.get("vault_entry")
                vault_secrets = params.get("vault_secrets") or {}
                engine = params.get("engine")  # "deepagents" | "legacy" | None
                history = params.get("history") or []
                stream_output = bool(params.get("stream_output", False))
                topolograph_runtime = params.get("topolograph_runtime")

                try:
                    # Load agent definition
                    agent_cfg = load_agent(agent_id)
                    if not agent_cfg:
                        raise ValueError(f"Agent '{agent_id}' not found")

                    # Get LLM config from settings
                    config = get_saved_config()

                    # Event callback that streams to stdout
                    def on_event(event):
                        event_msg = {"id": req_id, **event}
                        stdout.write(json.dumps(event_msg) + "\n")
                        stdout.flush()

                    # Route based on engine parameter
                    if engine == "deepagents":
                        from ccie_sidecar.agents.deepagents_runtime import deepagents_react_loop

                        # DeepAgents expects catalog as list
                        agent_def = build_deepagents_agent_definition(
                            agent_id=agent_id,
                            system_prompt=system_prompt or agent_cfg.get("system_prompt", ""),
                            tools=tools_raw,
                            vault_entry=vault_entry,
                            vault_secrets=vault_secrets,
                            topolograph_runtime=topolograph_runtime,
                        )

                        asyncio.run(deepagents_react_loop(
                            agent_def=agent_def,
                            user_msg=message,
                            ctx={"history": history},
                            on_event=on_event,
                            stream_output=stream_output,
                        ))
                    else:
                        # Legacy: expects catalog as JSON string
                        catalog_json_str = json.dumps(tools_raw) if isinstance(tools_raw, list) else tools_raw

                        agent_def = {
                            "id": agent_id,
                            "system_prompt": system_prompt or agent_cfg.get("system_prompt", ""),
                            "attached_tools": [{
                                "catalog": catalog_json_str,  # JSON string for legacy
                                "vault_entry": vault_entry,
                                "vault_secrets": vault_secrets,
                                # An optional caller override (used by the WhatsApp
                                # full-trust bridge, which has no interactive UI to
                                # grant approvals) raises the auto-approve ceiling so
                                # no HITL request is ever emitted headlessly.
                                "default_blast_radius_allowed": params.get("blast_radius_allowed")
                                or agent_cfg.get("default_blast_radius_allowed", "low"),
                            }],
                        }

                        asyncio.run(react_loop(
                            agent_def=agent_def,
                            user_msg=message,
                            ctx={"history": history},
                            on_event=on_event,
                            conversation_id=None,
                            db_conn=None
                        ))

                    # Send done
                    done_msg = {"id": req_id, "type": "done"}
                    stdout.write(json.dumps(done_msg) + "\n")
                    stdout.flush()

                except Exception as e:
                    import traceback
                    err_detail = traceback.format_exc()
                    err_msg = {"id": req_id, "type": "error", "message": f"{str(e)}\n{err_detail}"}
                    stdout.write(json.dumps(err_msg) + "\n")
                    stdout.flush()

            elif method == "agent.code_exec_loop":
                # Code execution agent loop - streaming method
                import asyncio
                from ccie_sidecar.agents import code_exec_loop

                agent_id = params.get("agent_id")
                message = params.get("message")
                system_prompt = params.get("system_prompt")
                tool_id = params.get("tool_id")
                catalog_path = params.get("catalog_path")
                vault_entry = params.get("vault_entry")
                vault_secrets = params.get("vault_secrets") or {}
                engine = params.get("engine")  # "deepagents" | "legacy" | None
                history = params.get("history") or []

                try:
                    # Build agent definition for code execution
                    # Attached tools are optional - agents can use basic Python sandbox
                    attached_tools = []
                    if tool_id:  # Only add if tool_id is provided
                        attached_tools.append({
                            "id": tool_id,
                            "catalog": catalog_path,
                            "vault_entry": vault_entry,
                            "vault_secrets": vault_secrets,
                        })

                    agent_def = {
                        "agent_id": agent_id,
                        "system_prompt": system_prompt or "",
                        "attached_tools": attached_tools
                    }

                    # Event callback that streams to stdout
                    def emit_event(event):
                        event_msg = {"id": req_id, **event}
                        stdout.write(json.dumps(event_msg) + "\n")
                        stdout.flush()

                    # Route based on engine parameter
                    if engine == "deepagents":
                        from ccie_sidecar.agents.deepagents_runtime import deepagents_code_exec_loop
                        asyncio.run(deepagents_code_exec_loop(
                            agent_def=agent_def,
                            user_msg=message,
                            ctx={"history": history},
                            on_event=emit_event
                        ))
                    else:
                        # Default to legacy
                        asyncio.run(code_exec_loop(
                            agent_def=agent_def,
                            user_msg=message,
                            ctx={"history": history},
                            on_event=emit_event
                        ))

                    # Send done
                    done_msg = {"id": req_id, "type": "done"}
                    stdout.write(json.dumps(done_msg) + "\n")
                    stdout.flush()

                except Exception as e:
                    import traceback
                    err_detail = traceback.format_exc()
                    err_msg = {"id": req_id, "type": "error", "message": f"{str(e)}\n{err_detail}"}
                    stdout.write(json.dumps(err_msg) + "\n")
                    stdout.flush()

            elif method == "agent.react_code_loop":
                # ReACT loop with code execution as the tool - streaming method
                import asyncio
                from ccie_sidecar.agents import react_code_loop

                agent_id = params.get("agent_id")
                message = params.get("message")
                system_prompt = params.get("system_prompt")
                tool_id = params.get("tool_id")
                vault_secrets = params.get("vault_secrets") or {}
                engine = params.get("engine")  # "deepagents" | "legacy" | None
                history = params.get("history") or []
                stream_output = bool(params.get("stream_output", False))
                topolograph_runtime = params.get("topolograph_runtime")

                try:
                    # Event callback that streams to stdout
                    def emit_event(event):
                        event_msg = {"id": req_id, **event}
                        stdout.write(json.dumps(event_msg) + "\n")
                        stdout.flush()

                    # Route based on engine parameter
                    if engine == "deepagents":
                        from ccie_sidecar.agents.deepagents_runtime import deepagents_react_code_loop

                        agent_def = build_deepagents_agent_definition(
                            agent_id=agent_id,
                            system_prompt=system_prompt or "",
                            tools=[],
                            vault_secrets=vault_secrets,
                            tool_id=tool_id,
                            topolograph_runtime=topolograph_runtime,
                        )

                        asyncio.run(deepagents_react_code_loop(
                            agent_def=agent_def,
                            user_msg=message,
                            ctx={
                                "history": history,
                                **(
                                    {"run_id": params.get("run_id")}
                                    if params.get("run_id") is not None
                                    else {}
                                ),
                                **(
                                    {"terminal_context": params.get("terminal_context")}
                                    if params.get("terminal_context") is not None
                                    else {}
                                ),
                            },
                            on_event=emit_event,
                            stream_output=stream_output,
                        ))
                    else:
                        # Legacy: flat structure
                        agent_def = {
                            "agent_id": agent_id,
                            "system_prompt": system_prompt or "",
                            "tool_id": tool_id,
                            "vault_secrets": vault_secrets,
                        }

                        asyncio.run(react_code_loop(
                            agent_def=agent_def,
                            user_msg=message,
                            ctx={"history": history},
                            on_event=emit_event
                        ))

                    # Send done
                    done_msg = {"id": req_id, "type": "done"}
                    stdout.write(json.dumps(done_msg) + "\n")
                    stdout.flush()

                except Exception as e:
                    import traceback
                    err_detail = traceback.format_exc()
                    err_msg = {"id": req_id, "type": "error", "message": f"{str(e)}\n{err_detail}"}
                    stdout.write(json.dumps(err_msg) + "\n")
                    stdout.flush()

            elif method == "agent.react_resume":
                # Resume an interrupted DeepAgents execution
                import asyncio
                from ccie_sidecar.agents.deepagents_state import retrieve_interrupted_graph
                from ccie_sidecar.agents.deepagents_hitl import continue_graph, resume_graph

                thread_id = params.get("thread_id")
                decision = params.get("decision")  # approval decision or checkpoint continuation
                edited_action = params.get("edited_action")
                stream_output = bool(params.get("stream_output", False))

                if not thread_id:
                    err_msg = {"id": req_id, "type": "error", "message": "thread_id required"}
                    stdout.write(json.dumps(err_msg) + "\n")
                    stdout.flush()
                    continue

                if not decision:
                    err_msg = {"id": req_id, "type": "error", "message": "decision required (approve|deny|edit)"}
                    stdout.write(json.dumps(err_msg) + "\n")
                    stdout.flush()
                    continue

                try:
                    # Retrieve interrupted graph state
                    state = retrieve_interrupted_graph(thread_id)
                    if not state:
                        err_msg = {"id": req_id, "type": "error", "message": f"No interrupted graph found for thread_id: {thread_id}"}
                        stdout.write(json.dumps(err_msg) + "\n")
                        stdout.flush()
                        continue

                    # Wrap on_event to add request ID
                    original_on_event = state.on_event
                    def emit_event(event):
                        event_msg = {"id": req_id, **event}
                        stdout.write(json.dumps(event_msg) + "\n")
                        stdout.flush()

                    # A step-limit continuation supplies no new prompt and no
                    # approval decision. HITL resumes keep their exact existing
                    # Command(resume=...) behavior.
                    if decision == "continue":
                        resume_outcome = asyncio.run(continue_graph(
                            graph=state.graph,
                            config=state.config,
                            on_event=emit_event,
                            stream_output=stream_output,
                        ))
                    else:
                        resume_outcome = asyncio.run(resume_graph(
                            graph=state.graph,
                            thread_id=thread_id,
                            decision=decision,
                            edited_action=edited_action,
                            on_event=emit_event,
                            stream_output=stream_output,
                        ))
                    if not resume_outcome.get("interrupted"):
                        from ccie_sidecar.agents.terminal_agent_tools import (
                            remove_terminal_context,
                            terminal_context_for_thread,
                        )
                        if terminal_context_for_thread(thread_id) is not None:
                            remove_terminal_context(thread_id)

                    # Send done
                    done_msg = {"id": req_id, "type": "done"}
                    stdout.write(json.dumps(done_msg) + "\n")
                    stdout.flush()

                except Exception as e:
                    import traceback
                    err_detail = traceback.format_exc()
                    err_msg = {"id": req_id, "type": "error", "message": f"{str(e)}\n{err_detail}"}
                    stdout.write(json.dumps(err_msg) + "\n")
                    stdout.flush()

        else:
            # Non-streaming response
            stdout.write(json.dumps(resp) + "\n")
            stdout.flush()


if __name__ == "__main__":
    run_loop()
