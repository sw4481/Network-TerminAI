"""Capability-scoped tools for Network Architect access to one attached PTY."""
from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from typing import Any, Callable

from langchain_core.tools import StructuredTool

Transport = Callable[[str, dict[str, Any]], dict[str, Any]]
Emitter = Callable[[dict[str, Any]], None]

_CONTEXTS: dict[str, dict[str, Any]] = {}
_CONTEXTS_LOCK = threading.Lock()
_DEVICE_COMMAND_REJECTED = "terminal command was rejected by the device:"


def register_terminal_context(thread_id: str, terminal_context: dict[str, Any]) -> None:
    with _CONTEXTS_LOCK:
        _CONTEXTS[thread_id] = dict(terminal_context)


def terminal_context_for_thread(thread_id: str) -> dict[str, Any] | None:
    with _CONTEXTS_LOCK:
        value = _CONTEXTS.get(thread_id)
        return dict(value) if value else None


def remove_terminal_context(thread_id: str) -> None:
    with _CONTEXTS_LOCK:
        _CONTEXTS.pop(thread_id, None)


class TerminalGatewayClient:
    def __init__(
        self,
        terminal_context: dict[str, Any],
        emit: Emitter,
        transport: Transport | None = None,
    ) -> None:
        self._context = dict(terminal_context)
        self._emit = emit
        self._transport = transport or self._http_post
        self._plan_started = False
        # LangGraph executes sibling tool calls concurrently. A PTY is a
        # single command stream, so command-bearing tools must queue here
        # before they reach the gateway's fail-closed active-capture guard.
        self._command_lock = threading.Lock()

    @property
    def lease_id(self) -> str:
        return str(self._context.get("lease_id") or "")

    def _http_post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        base_url = str(self._context.get("base_url") or "").rstrip("/")
        capability = str(self._context.get("capability") or "")
        if not base_url or not capability:
            raise ValueError("terminal gateway context is incomplete")
        request = urllib.request.Request(
            f"{base_url}{path}",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {capability}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=305) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as error:
            try:
                detail = json.loads(error.read().decode("utf-8")).get("error")
            except Exception:
                detail = None
            raise ValueError(detail or f"terminal gateway rejected request ({error.code})") from None
        except urllib.error.URLError as error:
            raise ValueError(f"terminal gateway unavailable: {error.reason}") from None

    def _post(self, path: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        result = self._transport(path, payload or {})
        if not isinstance(result, dict):
            raise ValueError("terminal gateway returned an invalid response")
        return result

    def read_context(self) -> str:
        return json.dumps(self._post("/context"), sort_keys=True)

    def begin_investigation(
        self,
        objective: str,
        hypotheses: list[str],
        steps: list[str],
        success_criteria: list[str],
    ) -> str:
        plan = {
            "objective": objective,
            "hypotheses": hypotheses,
            "steps": steps,
            "success_criteria": success_criteria,
        }
        result = self._post("/plan/begin", plan)
        self._plan_started = True
        self._emit({"type": "terminal_investigation_plan", "plan": plan, "updated": False})
        return json.dumps(result, sort_keys=True)

    def update_investigation(
        self,
        objective: str,
        hypotheses: list[str],
        steps: list[str],
        success_criteria: list[str],
    ) -> str:
        if not self._plan_started:
            raise ValueError("terminal diagnostics require an investigation plan first")
        plan = {
            "objective": objective,
            "hypotheses": hypotheses,
            "steps": steps,
            "success_criteria": success_criteria,
        }
        result = self._post("/plan/update", plan)
        self._emit({"type": "terminal_investigation_plan", "plan": plan, "updated": True})
        return json.dumps(result, sort_keys=True)

    def run_diagnostic(
        self,
        plan_step_id: str,
        command: str,
        purpose: str,
        timeout_seconds: int | None = None,
    ) -> str:
        if not self._plan_started:
            raise ValueError("terminal diagnostics require an investigation plan first")
        with self._command_lock:
            payload = {
                "plan_step_id": plan_step_id,
                "command": command,
                "purpose": purpose,
                "timeout_seconds": timeout_seconds,
            }
            self._emit({
                "type": "terminal_command_start",
                "plan_step_id": plan_step_id,
                "command": command,
                "purpose": purpose,
            })
            try:
                result = self._post("/diagnostic", payload)
            except Exception as error:
                message = str(error)
                if isinstance(error, ValueError) and message.startswith(_DEVICE_COMMAND_REJECTED):
                    result = {
                        "command": command,
                        "purpose": purpose,
                        "output": message.removeprefix(_DEVICE_COMMAND_REJECTED).lstrip(),
                        "exit_code": None,
                        "timed_out": False,
                        "truncated": False,
                        "device_error": True,
                    }
                    self._emit({
                        "type": "terminal_command_result",
                        "plan_step_id": plan_step_id,
                        "command": command,
                        "success": False,
                        "result": result,
                    })
                    return json.dumps(result, sort_keys=True)
                self._emit({
                    "type": "terminal_command_result",
                    "plan_step_id": plan_step_id,
                    "command": command,
                    "success": False,
                    "result": {"error": str(error)},
                })
                raise
            self._emit({
                "type": "terminal_command_result",
                "plan_step_id": plan_step_id,
                "command": command,
                "success": not bool(result.get("timed_out") or result.get("device_error")),
                "result": result,
            })
            return json.dumps(result, sort_keys=True)

    def preview_fix(
        self,
        summary: str,
        commands: list[str],
        verification_commands: list[str],
        rollback_commands: list[str],
    ) -> dict[str, Any]:
        return self._post("/fix/preview", {
            "summary": summary,
            "commands": commands,
            "verification_commands": verification_commands,
            "rollback_commands": rollback_commands,
        })

    def apply_fix(
        self,
        summary: str,
        commands: list[str],
        verification_commands: list[str],
        rollback_commands: list[str],
    ) -> str:
        if not self._plan_started:
            raise ValueError("terminal fixes require an investigation plan first")
        with self._command_lock:
            result = self._post("/fix/execute", {
                "summary": summary,
                "commands": commands,
                "verification_commands": verification_commands,
                "rollback_commands": rollback_commands,
            })
            return json.dumps(result, sort_keys=True)

    def cancel(self) -> None:
        self._post("/cancel")


def build_terminal_tools(
    terminal_context: dict[str, Any],
    emit: Emitter,
    transport: Transport | None = None,
) -> list[StructuredTool]:
    client = TerminalGatewayClient(terminal_context, emit, transport=transport)

    def terminal_read_context() -> str:
        """Read recent redacted context from the explicitly attached SSH terminal."""
        return client.read_context()

    def terminal_begin_investigation(
        objective: str,
        hypotheses: list[str],
        steps: list[str],
        success_criteria: list[str],
    ) -> str:
        """Create the visible troubleshooting plan. Must be called before commands."""
        return client.begin_investigation(objective, hypotheses, steps, success_criteria)

    def terminal_update_investigation(
        objective: str,
        hypotheses: list[str],
        steps: list[str],
        success_criteria: list[str],
    ) -> str:
        """Update the visible troubleshooting plan when evidence changes the approach."""
        return client.update_investigation(objective, hypotheses, steps, success_criteria)

    def terminal_run_diagnostic(
        plan_step_id: str,
        command: str,
        purpose: str,
        timeout_seconds: int | None = None,
    ) -> str:
        """Run one Tier-0 diagnostic in the attached terminal and return redacted evidence."""
        return client.run_diagnostic(plan_step_id, command, purpose, timeout_seconds)

    def terminal_apply_fix(
        summary: str,
        commands: list[str],
        verification_commands: list[str],
        rollback_commands: list[str],
    ) -> str:
        """Apply an exact reviewed fix batch. This always pauses for user approval first."""
        return client.apply_fix(summary, commands, verification_commands, rollback_commands)

    tools = [
        StructuredTool.from_function(terminal_read_context, name="terminal_read_context"),
        StructuredTool.from_function(
            terminal_begin_investigation, name="terminal_begin_investigation"
        ),
        StructuredTool.from_function(
            terminal_update_investigation, name="terminal_update_investigation"
        ),
        StructuredTool.from_function(
            terminal_run_diagnostic, name="terminal_run_diagnostic"
        ),
        StructuredTool.from_function(terminal_apply_fix, name="terminal_apply_fix"),
    ]
    tools[-1].metadata = {"blast_radius": "destructive"}
    return tools


def terminal_routing_contract(
    user_msg: str,
    terminal_context: dict[str, Any] | None,
) -> str:
    if not terminal_context:
        return ""
    target = terminal_context.get("target") or {}
    display = target.get("displayName") or target.get("backendPtyId") or "attached device"
    return (
        "ATTACHED TERMINAL OVERRIDE (this turn only):\n"
        f"- Investigate the attached terminal target {display!r} for wording such as "
        "'this switch' or 'this device'.\n"
        "- Create terminal_begin_investigation before any terminal command.\n"
        "- Use terminal_read_context and Tier-0 terminal_run_diagnostic commands for evidence.\n"
        "- Do not route RADIUS/TACACS wording to an ISE API unless the user explicitly asks "
        "for ISE data or approves expanding beyond this attached device.\n"
        "- Propose changes only through terminal_apply_fix. Tie the final conclusion to commands "
        "and redacted evidence; label it confirmed root cause, supported probable cause, or unresolved."
    )
