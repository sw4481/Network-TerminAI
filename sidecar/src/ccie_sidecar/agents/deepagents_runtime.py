"""DeepAgents runtime orchestrators with legacy loop signatures.

Provides deepagents_code_exec_loop / deepagents_react_loop / deepagents_react_code_loop
with the exact signatures of the legacy loops, enabling feature-flagged rollout.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Callable

from deepagents import create_deep_agent, SubAgent, RubricMiddleware
from langchain_core.messages import AIMessage, HumanMessage


def _build_input_messages(ctx: dict, user_msg: str) -> list:
    """Build the LangGraph input message list from prior history + the new turn.

    ctx may carry {"history": [{"role": "user"|"assistant", "content": str}, ...]}
    forwarded from the frontend so the agent has multi-turn context (e.g. a
    network the user already named). Falls back to a single-message
    conversation when no history is present.
    """
    messages: list = []
    history = (ctx or {}).get("history") or []
    for turn in history:
        if not isinstance(turn, dict):
            continue
        role = turn.get("role")
        content = turn.get("content") or ""
        if not content.strip():
            continue
        if role == "user":
            messages.append(HumanMessage(content=content))
        elif role == "assistant":
            messages.append(AIMessage(content=content))

    # READ-BEFORE-ANSWER: pre-load established knowledge about the entities this
    # question names as a conversation turn, so the agent starts already knowing
    # (e.g.) shaun-home's network_id and topology instead of being told to look
    # it up. This is the "second brain" retrieval phase — facts as knowledge the
    # agent has, not a directive it may ignore. No-op / empty when the flag is
    # off or nothing relevant is stored.
    try:
        from ccie_sidecar.agents.graph_autocapture import recall_context_message
        recalled = recall_context_message(user_msg)
        if recalled:
            messages.append(HumanMessage(content=recalled))
            messages.append(AIMessage(
                content="Understood — I'll use that established context and only "
                "query the vendor API for anything not already known above."
            ))
    except Exception:
        pass

    messages.append(HumanMessage(content=user_msg))
    return messages

from ccie_sidecar.providers.langchain_factory import build_chat_model
from ccie_sidecar.agents.deepagents_tools import create_execute_python_code_tool
from ccie_sidecar.agents.deepagents_stream import run_and_stream_code_exec
from ccie_sidecar.agents.deepagents_hitl import tier_for_tool, should_interrupt
from ccie_sidecar.agents.deepagents_middleware import ToolCallSanitizerMiddleware
from ccie_sidecar.agents.model_recovery import (
    AgentExecutionPolicy,
    ModelProtocolRecoveryMiddleware,
    ModelRecoveryTelemetry,
)


# Hard backstop on graph steps. DeepAgents defaults recursion_limit to 9_999,
# which lets a degenerating small model loop ~indefinitely (the "Verify the
# change" runaway). Cap it so a stuck run terminates in bounded time instead.
# Each ReAct cycle is ~2 graph steps, so 60 ≈ 30 tool calls — ample for the
# multi-step Meraki flows, tight enough to stop a loop fast.
RECURSION_LIMIT = 60


def _resolve_react_code_execution_policy(
    policy: AgentExecutionPolicy | None,
) -> AgentExecutionPolicy:
    """Keep interactive recovery opt-in while allowing explicit run policies."""

    if policy is not None:
        return policy
    return AgentExecutionPolicy(protocol_recovery_enabled=False)


# Self-evaluation rubric passed on invocation state. RubricMiddleware grades the
# agent's final answer against this and, if unsatisfied, loops back to the model
# (bounded by max_iterations). This is the DeepAgents-native "are you actually
# done?" check — it replaces the ad-hoc ContinuationGuard, which could not tell
# "done" from "looping" and amplified runaways.
TASK_COMPLETION_RUBRIC = (
    "Evaluate whether the agent fully and correctly completed the user's request:\n"
    "1. If the user asked to CHANGE something, did the agent actually call the "
    "update/create/delete method (not just describe it) AND verify the new value "
    "with a fresh GET?\n"
    "2. If the user asked to LIST/SHOW, did the agent return the real data "
    "(not a placeholder or a promise to do it)?\n"
    "3. Is the final answer a single, complete, non-repeating response with the "
    "actual results — not a half-formed sentence, not the same paragraph repeated?\n"
    "Grade 'satisfied' ONLY if the task is genuinely done and the answer is clean. "
    "Grade 'failed' with specific feedback if the agent looped, repeated itself, "
    "stopped early, or only narrated an action without performing it."
)


def _platform_aware_rubric(user_msg: str, configured_ids: list) -> str:
    """The task rubric, plus a platform-match clause when the question names a
    specific configured vendor. This closes the grader gap where a real device
    list from the WRONG vendor passed as 'satisfied' (Mist data answering an ISE
    question). Falls back to the plain rubric when no vendor is named."""
    from ccie_sidecar.agents.architect_subagents import detect_vendor_ids, _display_for

    hits = detect_vendor_ids(user_msg, restrict_to=configured_ids)
    if not hits:
        return TASK_COMPLETION_RUBRIC
    names = ", ".join(_display_for(v) for v in hits)
    return (
        TASK_COMPLETION_RUBRIC
        + "\n4. PLATFORM MATCH: the user's question is about "
        + f"{names}. The answer MUST present data from that platform. Grade "
        "'failed' if the answer reports data from a DIFFERENT vendor (e.g. "
        "repeats a prior platform's results) instead of the one asked about."
    )


def _build_grader_model(config: dict):
    """Build a model for the rubric grader (reuses provider; lighter model if known)."""
    grader_config = {**(config or {})}
    provider = grader_config.get("provider")
    if provider == "anthropic":
        grader_config["model"] = "claude-haiku-4-5"
    elif provider == "openai":
        grader_config["model"] = "gpt-4o-mini"
    # For vllm/nvidia/ollama/local, keep the same model — there's only one served.
    try:
        return build_chat_model(grader_config)
    except Exception:
        # Fall back to the primary model if the grader-specific build fails.
        return build_chat_model(config)


def _rubric_middleware(config: dict) -> RubricMiddleware:
    """RubricMiddleware is safe to include unconditionally; it activates only when
    a `rubric` is present in invocation state (which we pass for change/verify
    flows). max_iterations bounds how many times it can loop the model back."""
    return RubricMiddleware(
        model=_build_grader_model(config),
        system_prompt=(
            "You are a strict grader checking whether a network-automation agent "
            "completed the user's request. Be concise and decisive."
        ),
        max_iterations=2,
    )


def _is_iac_agent(cli_package: str | None) -> bool:
    """True when the agent is an IaC agent that should get the gated iac_apply
    tool. Scoped to the "iac" cli_package so meraki/pyats agents are unaffected."""
    return cli_package == "iac"


def _iac_extra_tools() -> list:
    """The extra tools an IaC agent gets beyond execute_python_code:
    the gated iac_apply plus the Phase 4 NL codegen tools. Factored out so the
    wiring is testable without constructing a full graph."""
    from ccie_sidecar.agents.iac_tools import build_iac_apply_tool
    from ccie_sidecar.agents.iac_codegen_tools import (
        build_ansible_codegen_tool,
        build_terraform_codegen_tool,
    )
    return [
        build_iac_apply_tool(),
        build_terraform_codegen_tool(),
        build_ansible_codegen_tool(),
    ]


IAC_CODEGEN_GUIDANCE = """
## Infrastructure-as-Code code generation

When the user asks you to create or change infrastructure in natural language:
1. Call `generate_terraform_code` (or `generate_ansible_playbook`) with a clear
   `intent` and the current `working_dir`. It returns JSON with the code,
   a suggested filename, an explanation, and syntax-validation status.
2. Show the generated code to the user in a fenced code block and summarise what
   it does and its likely blast radius. If `validation.valid` is false, say so.
3. Only if the user wants to apply it: write the code to the suggested filename
   inside the working directory using `execute_python_code`, then call
   `iac_apply` with that working_dir and the matching command (e.g.
   `terraform apply` or `ansible-playbook <file>`). `iac_apply` ALWAYS pauses for
   human approval — never try to bypass it via execute_python_code.
Never run `terraform apply`/`destroy` or `ansible-playbook` through
execute_python_code; that path is blocked. Apply only via `iac_apply`.
"""


def _iac_system_prompt(base_prompt: str) -> str:
    """Append IaC codegen workflow guidance to the agent's own system prompt."""
    return f"{base_prompt}\n{IAC_CODEGEN_GUIDANCE}"


def _get_checkpointer() -> "InMemorySaver":
    """
    Checkpointer for interrupt/resume.

    Returns an InMemorySaver (not SqliteSaver.from_conn_string, which is a
    context manager — passing it to create_deep_agent raises "Invalid
    checkpointer ... Received _GeneratorContextManager"). In-memory is correct
    here: the paused graph is also held in the in-process GraphStateRegistry and
    resumed within the same sidecar process, so disk persistence buys nothing.

    Returns:
        InMemorySaver instance.
    """
    from langgraph.checkpoint.memory import InMemorySaver

    return InMemorySaver()


async def deepagents_code_exec_loop(
    agent_def: dict,
    user_msg: str,
    ctx: dict,
    on_event: Callable[[dict], None],
) -> None:
    """
    DeepAgents implementation of code_exec_loop.

    Uses a single execute_python_code tool with our custom sandbox.
    No approval, no catalog, no planning — simplest topology to test Seam 2.

    Args:
        agent_def: Agent configuration with attached_tools
        user_msg: User's query
        ctx: Additional context (unused)
        on_event: Callback to emit events to frontend

    Events emitted (CodeExecEvent contract):
        - code_start: { type: "code_start", code: str }
        - code_executing: { type: "code_executing" }
        - code_result: { type: "code_result", success: bool, output: str }
        - code_error: { type: "code_error", error: str, attempt: int }
        - diagram: { type: "diagram", title: str, format: str, xml: str | None,
                     source: str | None, url: str }
        - final: { type: "final", response: str }
        - error: { type: "error", message: str }
    """
    from ccie_sidecar.agent import get_saved_config
    from langgraph.store.memory import InMemoryStore

    try:
        # 1. Load provider config
        config = get_saved_config() or {}

        # Allow agent model_override
        if agent_def.get("model_override"):
            override = agent_def["model_override"]
            if isinstance(override, dict):
                config.update(override)

        # 2. Build chat model
        chat_model = build_chat_model(config)

        # 3. Build sandbox and tool
        tool_def = agent_def.get("attached_tools", [{}])[0] if agent_def.get("attached_tools") else {}
        vault_secrets = tool_def.get("vault_secrets", {})
        cli_package = tool_def.get("id", "meraki") if tool_def else None

        # Forward custom sandbox events (diagrams) to the frontend IMMEDIATELY.
        # The sandbox runs synchronously inside the tool call, so emitting here
        # streams the diagram the moment the helper produces it. (Buffering and
        # draining on the next event stranded a trailing diagram — the last
        # action of a turn — because no event followed it.) Mirrors the legacy
        # loops, which pass on_event straight through as the sandbox emit.
        def emit_custom(event: dict) -> None:
            on_event(event)

        execute_code_tool = create_execute_python_code_tool(
            cli_package=cli_package,
            vault_secrets=vault_secrets,
            emit_callback=emit_custom,
        )

        # 4. Create DeepAgents graph
        # TodoList/planning middleware is on by default. Sanitizer repairs
        # malformed tool-call args; RubricMiddleware adds the self-evaluated
        # "are you done?" check (replaces the runaway-prone ContinuationGuard).
        from ccie_sidecar.agents.code_exec import (
            PROXMOX_SANDBOX_BLURB,
            UTILITY_SANDBOX_BLURB,
            SANDBOX_SHAPE_DISCIPLINE_BLURB,
            graph_sandbox_blurb_suffix,
        )
        graph = create_deep_agent(
            model=chat_model,
            tools=[execute_code_tool],
            system_prompt=(agent_def.get("system_prompt", "") or "")
            + "\n\n" + PROXMOX_SANDBOX_BLURB
            + "\n\n" + UTILITY_SANDBOX_BLURB
            + "\n\n" + SANDBOX_SHAPE_DISCIPLINE_BLURB
            + graph_sandbox_blurb_suffix(user_msg),
            store=InMemoryStore(),  # Required by DeepAgents
            middleware=[ToolCallSanitizerMiddleware(), _rubric_middleware(config)],
        )

        # 5. Prepare input (rubric activates RubricMiddleware self-evaluation)
        input_data = {
            "messages": _build_input_messages(ctx, user_msg),
            "rubric": TASK_COMPLETION_RUBRIC,
        }

        # 6. Run and stream. Diagram events already stream live via emit_custom
        # (above), so the graph-event callback is just on_event.
        wrapped_on_event = on_event

        await run_and_stream_code_exec(
            graph=graph,
            input_data=input_data,
            config={
                "configurable": {"thread_id": "default"},
                "recursion_limit": RECURSION_LIMIT,
            },
            on_event=wrapped_on_event,
        )

    except Exception as e:
        import sys
        import traceback
        tb = traceback.format_exc()
        print(f"[deepagents_code_exec_loop] EXCEPTION:\n{tb}", file=sys.stderr)
        on_event({
            "type": "error",
            "message": f"DeepAgents code_exec error: {str(e)}\n{tb}",
        })


async def deepagents_react_loop(
    agent_def: dict,
    user_msg: str,
    ctx: dict,
    on_event: Callable[[dict], None],
    enable_rubrics: bool = False,  # Phase 5: Optional rubrics (beta feature)
) -> None:
    """
    DeepAgents implementation of react_loop.

    Uses Meraki catalog tools. Phase 3 will add planning middleware.

    Args:
        agent_def: Agent configuration with attached_tools
        user_msg: User's query
        ctx: Additional context (conversation history, etc.)
        on_event: Callback to emit events

    Events emitted (ReactEvent contract):
        - thought_start: { type: "thought_start", thought: str, step: int }
        - tool_call: { type: "tool_call", name: str, args: dict, blast_radius: str }
        - tool_result: { type: "tool_result", success: bool, result: str }
        - diagram: { type: "diagram", ... }
        - final: { type: "final", response: str }
        - error: { type: "error", message: str }
    """
    from ccie_sidecar.agent import get_saved_config
    from ccie_sidecar.agents.deepagents_tools import convert_meraki_catalog_to_langchain_tools
    from langgraph.store.memory import InMemoryStore

    try:
        # 1. Load provider config
        config = get_saved_config() or {}

        if agent_def.get("model_override"):
            override = agent_def["model_override"]
            if isinstance(override, dict):
                config.update(override)

        # 2. Build chat model
        chat_model = build_chat_model(config)

        # 3. Load Meraki catalog
        tool_def = agent_def.get("attached_tools", [{}])[0] if agent_def.get("attached_tools") else {}
        catalog = tool_def.get("catalog", [])
        vault_entry = tool_def.get("vault_entry")
        vault_secrets = tool_def.get("vault_secrets", {})

        # Convert catalog to LangChain tools with actual execution
        tools = convert_meraki_catalog_to_langchain_tools(catalog, vault_entry, vault_secrets)

        # 4. Create DeepAgents graph with SubAgents
        # Phase 3: Add discovery and rendering subagents for isolated context
        # TodoListMiddleware is automatic

        # Define subagents for multi-step flows
        discovery_subagent = SubAgent(
            name="discovery",
            description="Discover devices, networks, and topology information",
            system_prompt=(
                "You are a discovery specialist. "
                "Your job is to gather information about devices, networks, and topology. "
                "Use the available Meraki API tools to list organizations, networks, and devices. "
                "Return structured data about what you discovered."
            ),
            # Inherits parent tools
        )

        rendering_subagent = SubAgent(
            name="rendering",
            description="Render diagrams and visualizations from discovered data",
            system_prompt=(
                "You are a rendering specialist. "
                "Your job is to take discovered network data and create clear visualizations. "
                "Use drawio or other diagram tools to create network topology diagrams. "
                "Focus on clear, accurate representation of the network structure."
            ),
            # Inherits parent tools (including execute_python_code for drawio)
        )

        # Sanitizer repairs malformed tool-call args (NVIDIA/Nemotron 400);
        # RubricMiddleware provides the self-evaluated "are you done?" check
        # (planning/write_todos is on by default). The rubric is passed in
        # input_data so the middleware actually activates.
        middleware = [ToolCallSanitizerMiddleware(), _rubric_middleware(config)]

        graph = create_deep_agent(
            model=chat_model,
            tools=tools,
            system_prompt=agent_def.get("system_prompt", ""),
            store=InMemoryStore(),
            subagents=[discovery_subagent, rendering_subagent],  # Phase 3: SubAgent middleware
            middleware=middleware,
        )

        # 5. Prepare input (rubric activates RubricMiddleware self-evaluation)
        input_data = {
            "messages": _build_input_messages(ctx, user_msg),
            "rubric": TASK_COMPLETION_RUBRIC,
        }

        # 6. Run and stream
        from ccie_sidecar.agents.deepagents_stream import run_and_stream

        await run_and_stream(
            graph=graph,
            input_data=input_data,
            config={
                "configurable": {"thread_id": "default"},
                "recursion_limit": RECURSION_LIMIT,
            },
            on_event=on_event,
        )

    except Exception as e:
        import sys
        import traceback
        tb = traceback.format_exc()
        print(f"[deepagents_react_loop] EXCEPTION:\n{tb}", file=sys.stderr)
        on_event({
            "type": "error",
            "message": f"DeepAgents react error: {str(e)}\n{tb}",
        })


async def deepagents_react_code_loop(
    agent_def: dict,
    user_msg: str,
    ctx: dict,
    on_event: Callable[[dict], None],
    execution_policy: AgentExecutionPolicy | None = None,
) -> dict[str, Any]:
    """
    DeepAgents implementation of react_code_loop.

    Uses ReAct with a single execute_python_code tool. Phase 3 will add middleware.

    Args:
        agent_def: Agent configuration
        user_msg: User's query
        ctx: Additional context
        on_event: Callback to emit events
        execution_policy: Optional run policy. Interactive callers default to
            recovery disabled; unattended heartbeats opt in explicitly.

    Events emitted (ReactEvent contract):
        - thought_start
        - tool_call
        - tool_result
        - diagram
        - final
        - error
    """
    from ccie_sidecar.agent import get_saved_config
    from langgraph.store.memory import InMemoryStore

    recovery_telemetries: list[ModelRecoveryTelemetry] = []
    outcome: dict[str, Any] | None = None

    def new_recovery_middleware(
        policy: AgentExecutionPolicy,
    ) -> ModelProtocolRecoveryMiddleware:
        telemetry = ModelRecoveryTelemetry()
        recovery_telemetries.append(telemetry)
        return ModelProtocolRecoveryMiddleware(policy=policy, telemetry=telemetry)

    try:
        # 1. Load provider config
        config = get_saved_config() or {}

        if agent_def.get("model_override"):
            override = agent_def["model_override"]
            if isinstance(override, dict):
                config.update(override)

        # 2. Build chat model
        chat_model = build_chat_model(config)
        # Interactive callers retain their existing one-call behavior. The
        # unattended heartbeat path opts into the canary recovery policy
        # explicitly; widening it later requires only passing the same policy.
        execution_policy = _resolve_react_code_execution_policy(execution_policy)
        primary_recovery = new_recovery_middleware(execution_policy)

        # 3. Build sandbox and tool
        tool_def = agent_def.get("attached_tools", [{}])[0] if agent_def.get("attached_tools") else {}
        vault_secrets = tool_def.get("vault_secrets", {}) or {}
        cli_package = tool_def.get("id", "meraki") if tool_def else None

        # Forward custom sandbox events (diagrams) to the frontend immediately —
        # see the note in deepagents_code_exec_loop. Buffering stranded a
        # trailing diagram (the common case: a diagram is the turn's last act).
        def emit_custom(event: dict) -> None:
            on_event(event)

        is_architect = (agent_def.get("agent_id") or agent_def.get("name")) == "network-architect"

        graph_kwargs: dict = {}
        extra_middleware: list = []
        arch_configured_ids: list = []
        arch_routing_hint = ""

        # Network Architect orchestrator. FLATTENED single-vendor path: the
        # orchestrator's OWN execute_python_code sandbox binds every configured
        # vendor helper directly, so a single-platform question is answered inline
        # (~2 LLM calls) instead of delegating to a subagent (~5-6 calls — measured).
        # Subagents stay available for genuine multi-vendor parallel correlation.
        if is_architect:
            from ccie_sidecar.agents.architect_subagents import (
                build_architect_direct_tool,
                build_vendor_subagents,
                architect_routing_hint,
            )
            execute_code_tool, _arch_ids = build_architect_direct_tool(
                emit=emit_custom, user_msg=user_msg,
            )
            # Declarative DeepAgents subagents have their own middleware stacks;
            # explicitly add the same provider-neutral recovery policy so both
            # delegated vendor calls and the architect's inline path are covered.
            vendor_subagents = []
            for subagent in build_vendor_subagents(emit=emit_custom):
                vendor_subagents.append(
                    SubAgent(
                        **{
                            **subagent,
                            "middleware": [
                                *(subagent.get("middleware") or []),
                                new_recovery_middleware(execution_policy),
                            ],
                        }
                    )
                )
            graph_kwargs["subagents"] = vendor_subagents
            arch_configured_ids = _arch_ids
            # Fix #2: deterministic vendor hint — nudge the model toward the
            # platform the question names, before it anchors on the prior turn.
            arch_routing_hint = architect_routing_hint(user_msg, _arch_ids)
        else:
            execute_code_tool = create_execute_python_code_tool(
                cli_package=cli_package,
                vault_secrets=vault_secrets,
                emit_callback=emit_custom,
            )

        # IaC agents additionally get the gated iac_apply tool plus Phase 4 NL codegen
        # tools. It is scoped to the "iac" cli_package so meraki/pyats agents never
        # see it. interrupt_on pauses the graph before any apply runs, so the frontend
        # can show an approval modal (the tool is also self-tagged destructive). A
        # checkpointer is required for interrupt/resume.
        tools = [execute_code_tool]

        if _is_iac_agent(cli_package):
            from ccie_sidecar.agents.deepagents_middleware import HideBuiltinFsToolsMiddleware
            # iac_apply (gated) + Phase 4 NL codegen tools.
            tools.extend(_iac_extra_tools())
            # Only iac_apply pauses the graph; codegen tools return code and never
            # mutate infrastructure, so they are NOT in interrupt_on.
            graph_kwargs["interrupt_on"] = {"iac_apply": True}
            graph_kwargs["checkpointer"] = _get_checkpointer()
            # create_deep_agent always injects built-in filesystem tools backed by
            # a VIRTUAL empty FS. The model's exploratory `ls` returns nothing and
            # it loops forever. Strip those tools — the IaC agent works through
            # execute_python_code (real subprocess) + the gated iac_apply.
            extra_middleware.append(HideBuiltinFsToolsMiddleware())

        # 4. Create DeepAgents graph
        # Sanitizer repairs malformed tool-call args (NVIDIA/Nemotron 400).
        # RubricMiddleware provides the self-evaluated "are you done?" check
        # (planning/write_todos is on by default). Together these replace the
        # ad-hoc ContinuationGuard, which amplified runaway loops.
        base_prompt = agent_def.get("system_prompt", "")
        system_prompt = (
            _iac_system_prompt(base_prompt)
            if _is_iac_agent(cli_package)
            else base_prompt
        )
        from ccie_sidecar.agents.code_exec import (
            PROXMOX_SANDBOX_BLURB,
            UTILITY_SANDBOX_BLURB,
            SANDBOX_SHAPE_DISCIPLINE_BLURB,
            graph_sandbox_blurb_suffix,
        )
        from ccie_sidecar.agents.lessons import lessons_blurb
        # Architect binds many vendors in one sandbox → 'global' lessons only;
        # single-vendor agents get their scope's lessons plus 'global'.
        lessons_scope = "global" if is_architect else cli_package
        system_prompt = (
            (system_prompt or "")
            + "\n\n" + PROXMOX_SANDBOX_BLURB
            + "\n\n" + UTILITY_SANDBOX_BLURB
            + "\n\n" + SANDBOX_SHAPE_DISCIPLINE_BLURB
            + graph_sandbox_blurb_suffix(user_msg)
            + lessons_blurb(lessons_scope)
        )
        # Fix #2: prepend the deterministic vendor routing hint (architect only;
        # "" when the question names no configured vendor).
        if arch_routing_hint:
            system_prompt = arch_routing_hint + "\n\n" + system_prompt
        graph = create_deep_agent(
            model=chat_model,
            tools=tools,
            system_prompt=system_prompt,
            store=InMemoryStore(),
            middleware=[
                primary_recovery,
                ToolCallSanitizerMiddleware(),
                _rubric_middleware(config),
                *extra_middleware,
            ],
            **graph_kwargs,
        )

        # 5. Prepare input (rubric activates RubricMiddleware self-evaluation).
        # Fix #1 (architect only): condense stale prior-turn answers about a
        # DIFFERENT vendor so the model doesn't anchor on them and re-run the
        # wrong platform. Fix #3: platform-match rubric clause when the question
        # names a specific configured vendor.
        turn_ctx = ctx
        rubric = TASK_COMPLETION_RUBRIC
        if is_architect:
            from ccie_sidecar.agents.architect_subagents import scope_history_for_question
            scoped_history = scope_history_for_question(
                (ctx or {}).get("history") or [], user_msg, arch_configured_ids
            )
            turn_ctx = {**(ctx or {}), "history": scoped_history}
            rubric = _platform_aware_rubric(user_msg, arch_configured_ids)
        input_data = {
            "messages": _build_input_messages(turn_ctx, user_msg),
            "rubric": rubric,
        }

        # 6. Run and stream. Diagram events already stream live via emit_custom
        # (above), so the graph-event callback is just on_event.
        from ccie_sidecar.agents.deepagents_stream import run_and_stream
        from ccie_sidecar.agents.lessons import LessonObserver, distill_and_store

        # Passively observe tool successes/failures for post-turn distillation.
        # Byte-identical event stream; no-op when the flag is off.
        wrapped_on_event = LessonObserver(on_event)

        outcome = await run_and_stream(
            graph=graph,
            input_data=input_data,
            config={
                "configurable": {"thread_id": "default"},
                "recursion_limit": RECURSION_LIMIT,
            },
            on_event=wrapped_on_event,
        )
        # Post-final: distill a lesson if this turn recovered from an error.
        # The user's answer already streamed, so this adds no answer latency.
        distill_and_store(wrapped_on_event, lessons_scope, user_msg)
        recovery_attempts = sum(
            telemetry.recovery_attempts for telemetry in recovery_telemetries
        )
        outcome["recovery_attempts"] = recovery_attempts
        if recovery_attempts:
            outcome["fallback_mode"] = "non_streaming_model_call"
        return outcome

    except Exception as e:
        import sys
        import traceback
        tb = traceback.format_exc()
        print(f"[deepagents_react_code_loop] EXCEPTION:\n{tb}", file=sys.stderr)
        on_event({
            "type": "error",
            "message": f"DeepAgents react_code error: {str(e)}\n{tb}",
            "kind": "runtime",
            "error_type": type(e).__name__,
        })
        recovery_attempts = sum(
            telemetry.recovery_attempts for telemetry in recovery_telemetries
        )
        failed_outcome = {
            "interrupted": False,
            "thread_id": "default",
            "final_emitted": False,
            "steps": 0,
            "error_kind": None,
            "error_type": None,
            "recovery_attempts": 0,
            "fallback_mode": None,
            **(outcome or {}),
        }
        failed_outcome.update(
            {
                "error_kind": "runtime",
                "error_type": type(e).__name__,
                "recovery_attempts": recovery_attempts,
                "fallback_mode": (
                    "non_streaming_model_call" if recovery_attempts else None
                ),
            }
        )
        return failed_outcome
