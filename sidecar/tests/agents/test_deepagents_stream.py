"""Unit tests for deepagents_stream.py — event mapping (Seam 2)."""
import pytest
from unittest.mock import MagicMock, AsyncMock
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, ToolMessage
from langchain_core.tools import ToolException

from ccie_sidecar.agents.deepagents_stream import run_and_stream_code_exec


class DirectStatusError(RuntimeError):
    def __init__(self, message: str, status_code: int) -> None:
        super().__init__(message)
        self.status_code = status_code


@pytest.mark.asyncio
async def test_code_exec_stream_basic_flow():
    """Test basic code execution flow: code_start → code_executing → code_result → final."""
    # Mock graph that simulates:
    # 1. AIMessage with execute_python_code tool call
    # 2. ToolMessage with success result
    # 3. AIMessage with final text

    async def mock_astream(input_data, config, stream_mode):
        # Simulate LangGraph astream events
        # Event 1: AIMessage with tool call
        yield ("updates", {
            "agent": {
                "messages": [AIMessage(
                    content="",
                    tool_calls=[{
                        "name": "execute_python_code",
                        "args": {"code": "print('hello world')"},
                        "id": "call_123",
                    }],
                )]
            }
        })

        # Event 2: ToolMessage with result
        yield ("updates", {
            "tools": {
                "messages": [ToolMessage(
                    content="hello world\n",
                    tool_call_id="call_123",
                )]
            }
        })

        # Event 3: Final AIMessage
        yield ("updates", {
            "agent": {
                "messages": [AIMessage(
                    content="I printed 'hello world' to the console.",
                )]
            }
        })

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream

    events = []
    def on_event(event):
        events.append(event)

    await run_and_stream_code_exec(
        graph=mock_graph,
        input_data={},
        config={},
        on_event=on_event,
    )

    # Verify event sequence matches CodeExecEvent contract
    assert len(events) == 4

    # code_start
    assert events[0]["type"] == "code_start"
    assert events[0]["code"] == "print('hello world')"

    # code_executing
    assert events[1]["type"] == "code_executing"

    # code_result
    assert events[2]["type"] == "code_result"
    assert events[2]["success"] is True
    assert events[2]["output"] == "hello world\n"

    # final
    assert events[3]["type"] == "final"
    assert "hello world" in events[3]["response"]


@pytest.mark.asyncio
async def test_code_exec_stream_error_retry():
    """Test code execution with error and retry."""
    async def mock_astream(input_data, config, stream_mode):
        # Attempt 1: Tool call + error result
        yield ("updates", {
            "agent": {
                "messages": [AIMessage(
                    content="",
                    tool_calls=[{
                        "name": "execute_python_code",
                        "args": {"code": "print(undefined_var)"},
                        "id": "call_1",
                    }],
                )]
            }
        })

        yield ("updates", {
            "tools": {
                "messages": [ToolMessage(
                    content="Error: NameError: name 'undefined_var' is not defined",
                    tool_call_id="call_1",
                )]
            }
        })

        # Attempt 2: Fixed code
        yield ("updates", {
            "agent": {
                "messages": [AIMessage(
                    content="",
                    tool_calls=[{
                        "name": "execute_python_code",
                        "args": {"code": "x = 42\nprint(x)"},
                        "id": "call_2",
                    }],
                )]
            }
        })

        yield ("updates", {
            "tools": {
                "messages": [ToolMessage(
                    content="42\n",
                    tool_call_id="call_2",
                )]
            }
        })

        # Final
        yield ("updates", {
            "agent": {
                "messages": [AIMessage(content="Fixed the error, x is 42.")]
            }
        })

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream

    events = []
    await run_and_stream_code_exec(mock_graph, {}, {}, events.append)

    # Should have: start1, exec1, error1, start2, exec2, result2, final
    assert len(events) == 7

    assert events[0]["type"] == "code_start"
    assert events[1]["type"] == "code_executing"
    assert events[2]["type"] == "code_error"
    assert events[2]["attempt"] == 1
    assert "NameError" in events[2]["error"]

    assert events[3]["type"] == "code_start"
    assert events[4]["type"] == "code_executing"
    assert events[5]["type"] == "code_result"
    assert events[5]["success"] is True

    assert events[6]["type"] == "final"


@pytest.mark.asyncio
async def test_diagram_event_passthrough():
    """Test that diagram custom events are passed through unchanged."""
    async def mock_astream(input_data, config, stream_mode):
        # Custom diagram event
        yield ("custom", {
            "type": "diagram",
            "title": "Network Topology",
            "format": "xml",
            "xml": "<mxGraphModel>...</mxGraphModel>",
            "source": None,
            "url": "https://app.diagrams.net/...",
        })

        # Then code result
        yield ("updates", {
            "tools": {
                "messages": [ToolMessage(
                    content="Diagram rendered",
                    tool_call_id="call_1",
                )]
            }
        })

        # Final
        yield ("updates", {
            "agent": {
                "messages": [AIMessage(content="Here's your topology diagram.")]
            }
        })

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream

    events = []
    await run_and_stream_code_exec(mock_graph, {}, {}, events.append)

    # Find diagram event
    diagram_events = [e for e in events if e["type"] == "diagram"]
    assert len(diagram_events) == 1

    diagram = diagram_events[0]
    assert diagram["title"] == "Network Topology"
    assert diagram["format"] == "xml"
    assert diagram["xml"] == "<mxGraphModel>...</mxGraphModel>"
    assert diagram["url"].startswith("https://app.diagrams.net/")


@pytest.mark.asyncio
async def test_react_stream_thought_and_tool_call():
    """Test React agent stream with thought_start and tool_call events."""
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        # AIMessage with reasoning text + tool call
        yield ("updates", {
            "agent": {
                "messages": [AIMessage(
                    content="I need to check the organizations first.",
                    tool_calls=[{
                        "name": "meraki_organizations_list",
                        "args": {},
                        "id": "call_1",
                    }],
                )]
            }
        })

        # ToolMessage result
        yield ("updates", {
            "tools": {
                "messages": [ToolMessage(
                    content='[{"id": "123", "name": "MyOrg"}]',
                    tool_call_id="call_1",
                )]
            }
        })

        # Final
        yield ("updates", {
            "agent": {
                "messages": [AIMessage(
                    content="You have 1 organization: MyOrg (ID: 123)."
                )]
            }
        })

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream

    events = []
    outcome = await run_and_stream(mock_graph, {}, {}, events.append)

    # Should have: thought_start, tool_call, tool_result, final
    assert len(events) == 4

    # thought_start
    assert events[0]["type"] == "thought_start"
    assert "organizations" in events[0]["thought"].lower()
    assert events[0]["step"] == 1

    # tool_call
    assert events[1]["type"] == "tool_call"
    assert events[1]["name"] == "meraki_organizations_list"
    assert events[1]["blast_radius"] == "medium"  # Default

    # tool_result
    assert events[2]["type"] == "tool_result"
    # ToolMessage omitted .name; the stream bridge retains provenance by
    # matching its tool_call_id to the preceding model tool call.
    assert events[2]["name"] == "meraki_organizations_list"
    assert events[2]["success"] is True
    assert "MyOrg" in events[2]["result"]

    # final
    assert events[3]["type"] == "final"
    assert "MyOrg" in events[3]["response"]
    assert outcome == {
        "interrupted": False,
        "thread_id": "default",
        "final_emitted": True,
        "steps": 1,
        "error_kind": None,
        "error_type": None,
        "recovery_attempts": 0,
        "fallback_mode": None,
    }


@pytest.mark.asyncio
async def test_react_stream_keeps_tokens_buffered_by_default():
    """The existing final-only contract remains the default."""
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        yield ((), "messages", (AIMessageChunk(content="Live answer"), {}))
        yield ((), "updates", {
            "agent": {"messages": [AIMessage(content="Live answer")]},
        })

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream
    events = []

    await run_and_stream(mock_graph, {}, {}, events.append)

    assert events == [{"type": "final", "response": "Live answer"}]


@pytest.mark.asyncio
async def test_react_stream_emits_only_top_level_tokens_when_enabled():
    """Opt-in streaming forwards model deltas without leaking subagent text."""
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        yield ((), "messages", (AIMessageChunk(content="Live "), {}))
        yield (("tools:subagent",), "messages", (
            AIMessageChunk(content="internal specialist text"),
            {},
        ))
        yield ((), "messages", (AIMessageChunk(content="answer"), {}))
        yield ((), "updates", {
            "agent": {"messages": [AIMessage(content="Live answer")]},
        })

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream
    events = []

    await run_and_stream(
        mock_graph,
        {},
        {},
        events.append,
        stream_output=True,
    )

    assert events == [
        {"type": "token", "text": "Live "},
        {"type": "token", "text": "answer"},
        {"type": "final", "response": "Live answer"},
    ]


@pytest.mark.asyncio
async def test_graph_recursion_error_surfaces_clean_message():
    """A GraphRecursionError (agent looped past the step cap) must surface as a
    clean, actionable error event — NOT the raw stack trace that reads as a crash."""
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from langgraph.errors import GraphRecursionError

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        # Emit one tool call, then blow the recursion limit like a real loop.
        yield ("updates", {
            "agent": {
                "messages": [AIMessage(
                    content="Looking for terraform...",
                    tool_calls=[{"name": "execute_python_code", "args": {"code": "ls"}, "id": "c1"}],
                )]
            }
        })
        raise GraphRecursionError("Recursion limit of 60 reached without hitting a stop condition.")

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream

    events = []
    result = await run_and_stream(mock_graph, {}, {}, events.append)

    # Not flagged as an interrupt (it's a genuine failure, not a HITL pause).
    assert result["interrupted"] is False
    assert result["final_emitted"] is False
    assert result["steps"] == 1
    assert result["error_kind"] == "step_limit"
    assert result["error_type"] == "GraphRecursionError"

    error_events = [e for e in events if e["type"] == "error"]
    assert len(error_events) == 1
    msg = error_events[0]["message"]
    # Clean, user-facing language — no raw exception class name leaking through.
    assert "GraphRecursionError" not in msg
    assert "stuck" in msg.lower()
    assert "terraform" not in msg.lower()


@pytest.mark.asyncio
async def test_graph_recursion_checkpoint_can_be_continued_without_replaying_prompt():
    """A long Network Architect run must pause with its exact graph state kept.

    The continuation signal is separate from HITL approval and carries only the
    opaque thread id needed to resume the already-checkpointed DeepAgents graph.
    """
    from ccie_sidecar.agents.deepagents_state import (
        clear_interrupted_graph,
        retrieve_interrupted_graph,
    )
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from langgraph.errors import GraphRecursionError

    thread_id = "architect-run-checkpoint"
    clear_interrupted_graph(thread_id)

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        if False:
            yield None
        raise GraphRecursionError("segment budget reached")

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream
    config = {
        "configurable": {"thread_id": thread_id},
        "recursion_limit": 60,
    }
    events = []

    outcome = await run_and_stream(
        mock_graph,
        {"messages": ["original prompt"]},
        config,
        events.append,
        continue_on_step_limit=True,
    )

    continuation = [e for e in events if e["type"] == "continuation_available"]
    assert continuation == [
        {
            "type": "continuation_available",
            "thread_id": thread_id,
            "reason": "step_limit",
        }
    ]
    assert "preserved" in events[-1]["message"].lower()
    assert outcome["continuation_available"] is True

    saved = retrieve_interrupted_graph(thread_id)
    assert saved is not None
    assert saved.graph is mock_graph
    assert saved.config == config


@pytest.mark.asyncio
async def test_continue_graph_resumes_checkpoint_with_no_new_input():
    """Continuing sends ``None`` so LangGraph advances from the checkpoint
    instead of appending or replaying the user's original request."""
    from ccie_sidecar.agents.deepagents_hitl import continue_graph

    observed = {}

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        observed["input_data"] = input_data
        observed["config"] = config
        yield ((), "updates", {
            "agent": {"messages": [AIMessage(content="Finished from checkpoint")]},
        })

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream
    config = {
        "configurable": {"thread_id": "architect-run-checkpoint"},
        "recursion_limit": 60,
    }
    events = []

    outcome = await continue_graph(
        graph=mock_graph,
        config=config,
        on_event=events.append,
    )

    assert observed == {"input_data": None, "config": config}
    assert outcome["final_emitted"] is True
    assert events[-1] == {"type": "final", "response": "Finished from checkpoint"}


@pytest.mark.asyncio
async def test_real_langgraph_checkpoint_advances_after_step_limit():
    """Integration proof against LangGraph itself, not a mocked resume API."""
    from typing_extensions import TypedDict

    from langgraph.checkpoint.memory import InMemorySaver
    from langgraph.graph import START, StateGraph

    from ccie_sidecar.agents.deepagents_hitl import continue_graph
    from ccie_sidecar.agents.deepagents_state import retrieve_interrupted_graph
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    class CounterState(TypedDict):
        count: int

    def increment(state: CounterState):
        return {"count": state["count"] + 1}

    def route(state: CounterState):
        return "increment" if state["count"] < 3 else "__end__"

    builder = StateGraph(CounterState)
    builder.add_node("increment", increment)
    builder.add_edge(START, "increment")
    builder.add_conditional_edges("increment", route)
    graph = builder.compile(checkpointer=InMemorySaver())
    config = {
        "configurable": {"thread_id": "real-checkpoint-proof"},
        "recursion_limit": 2,
    }

    first = await run_and_stream(
        graph,
        {"count": 0},
        config,
        lambda _event: None,
        continue_on_step_limit=True,
    )
    assert first["continuation_available"] is True
    assert graph.get_state(config).values["count"] == 2

    saved = retrieve_interrupted_graph("real-checkpoint-proof")
    assert saved is not None
    await continue_graph(saved.graph, saved.config, lambda _event: None)

    assert graph.get_state(config).values["count"] == 3
    assert graph.get_state(config).next == ()


@pytest.mark.asyncio
async def test_runtime_protocol_error_has_structured_outcome():
    """A malformed response that survives middleware is typed for heartbeats."""
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        if False:
            yield None
        raise RuntimeError("Unknown role: final")

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream
    events = []

    outcome = await run_and_stream(mock_graph, {}, {}, events.append)

    assert outcome["final_emitted"] is False
    assert outcome["steps"] == 0
    assert outcome["error_kind"] == "model_protocol"
    assert outcome["error_type"] == "RuntimeError"
    assert events[-1]["type"] == "error"
    assert events[-1]["kind"] == "model_protocol"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "expected_kind"),
    [
        (DirectStatusError("unauthorized", 401), "authentication"),
        (DirectStatusError("model not found", 404), "configuration"),
        (DirectStatusError("generic bad request", 400), "client_error"),
        (DirectStatusError("request timeout", 408), "timeout"),
        (DirectStatusError("too many requests", 429), "rate_limit"),
        (ValueError("maximum context length exceeded"), "context_overflow"),
        (TimeoutError("model timed out"), "timeout"),
        (ToolException("tool failed"), "tool"),
    ],
)
async def test_direct_permanent_error_keeps_structured_category(
    error,
    expected_kind,
):
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        if False:
            yield None
        raise error

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream
    events = []

    outcome = await run_and_stream(mock_graph, {}, {}, events.append)

    assert outcome["error_kind"] == expected_kind
    assert outcome["error_type"] == type(error).__name__
    assert outcome["recovery_attempts"] == 0
    assert events[-1]["kind"] == expected_kind


@pytest.mark.asyncio
async def test_failed_nonstream_recovery_has_structured_outcome():
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from ccie_sidecar.agents.model_recovery import ModelProtocolRecoveryError

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        if False:
            yield None
        first = RuntimeError("Unknown role: final")
        fallback = RuntimeError("failed to decode response")
        raise ModelProtocolRecoveryError(first, fallback) from fallback

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream
    events = []

    outcome = await run_and_stream(mock_graph, {}, {}, events.append)

    assert outcome["error_kind"] == "model_protocol"
    assert outcome["error_type"] == "RuntimeError"
    assert outcome["recovery_attempts"] == 1
    assert outcome["fallback_mode"] == "non_streaming_model_call"
    assert events[-1]["recovery_attempts"] == 1
    assert events[-1]["fallback_mode"] == "non_streaming_model_call"
    assert events[-1]["initial_error_type"] == "RuntimeError"
    assert events[-1]["fallback_error_type"] == "RuntimeError"


@pytest.mark.asyncio
async def test_failed_recovery_outcome_uses_fallback_final_category():
    from ccie_sidecar.agents.deepagents_stream import run_and_stream
    from ccie_sidecar.agents.model_recovery import ModelProtocolRecoveryError

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        if False:
            yield None
        first = RuntimeError("Unknown role: final")
        fallback = TimeoutError("model timed out")
        raise ModelProtocolRecoveryError(first, fallback) from fallback

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream
    events = []

    outcome = await run_and_stream(mock_graph, {}, {}, events.append)

    assert outcome["error_kind"] == "timeout"
    assert outcome["error_type"] == "TimeoutError"
    assert outcome["recovery_attempts"] == 1
    assert events[-1]["kind"] == "timeout"


@pytest.mark.asyncio
async def test_empty_stream_is_explicitly_not_final():
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        if False:
            yield None

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream

    outcome = await run_and_stream(mock_graph, {}, {}, lambda event: None)

    assert outcome["final_emitted"] is False
    assert outcome["error_kind"] is None
    assert outcome["steps"] == 0


def test_describe_tool_calls_summarizes_code():
    """Empty-reasoning fallback should describe the action, not render blank."""
    from ccie_sidecar.agents.deepagents_stream import _describe_tool_calls

    assert _describe_tool_calls([
        {"name": "execute_python_code", "args": {"code": "# Find the network\nnet = meraki.x()"}}
    ]) == "Running code: Find the network"

    assert _describe_tool_calls([
        {"name": "execute_python_code", "args": {"code": "orgs = meraki.organizations.getOrganizations()"}}
    ]) == "Running code: orgs = meraki.organizations.getOrganizations()"

    assert _describe_tool_calls([{"name": "write_todos", "args": {}}]) == "Planning next steps"
    assert _describe_tool_calls([{"name": "execute_python_code", "args": {"code": ""}}]) == "Running code"
    assert _describe_tool_calls([]) == "Working..."


@pytest.mark.asyncio
async def test_whitespace_only_thought_falls_back_to_description():
    """A model that emits whitespace-only content must not render a blank step."""
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        # AIMessage with whitespace-only content (the bug: renders as blank step)
        yield ("updates", {
            "agent": {
                "messages": [AIMessage(
                    content="\n\n",
                    tool_calls=[{
                        "name": "execute_python_code",
                        "args": {"code": "policies = meraki.switch.getNetworkSwitchAccessPolicies(net_id)"},
                        "id": "call_1",
                    }],
                )]
            }
        })

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream

    events = []
    await run_and_stream(mock_graph, {}, {}, events.append)

    thought = next(e for e in events if e["type"] == "thought_start")
    assert thought["thought"].strip()  # never blank
    assert "getNetworkSwitchAccessPolicies" in thought["thought"]


@pytest.mark.asyncio
async def test_no_double_final():
    """Test that final event only fires once, even if multiple AIMessages appear."""
    async def mock_astream(input_data, config, stream_mode):
        # First final-like message
        yield ("updates", {
            "agent": {
                "messages": [AIMessage(content="Processing...")]
            }
        })

        # Second final-like message (should be ignored)
        yield ("updates", {
            "agent": {
                "messages": [AIMessage(content="Still processing...")]
            }
        })

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream

    events = []
    await run_and_stream_code_exec(mock_graph, {}, {}, events.append)

    # Only the first final should fire
    final_events = [e for e in events if e["type"] == "final"]
    assert len(final_events) == 1
    assert final_events[0]["response"] == "Processing..."


@pytest.mark.asyncio
async def test_react_stream_never_replays_input_history_as_final():
    """A prior assistant turn surfaced by LangGraph is history, not a new answer."""
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    history_id = "history-assistant-1"

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        yield ((), "updates", {"agent": {"messages": [AIMessage(
            content="Understood — I'll use that established context.",
            id=history_id,
        )]}})
        yield ((), "updates", {"agent": {"messages": [AIMessage(
            content="Example-Branch has three switch access policies.",
            id="new-answer",
        )]}})

    input_data = {"messages": [
        HumanMessage(content="How healthy is ISE?"),
        AIMessage(
            content="Understood — I'll use that established context.",
            id=history_id,
        ),
        HumanMessage(content="List Example-Branch access policies"),
    ]}
    mock_graph = MagicMock()
    mock_graph.astream = mock_astream
    events = []

    await run_and_stream(mock_graph, input_data, {}, events.append)

    assert [event for event in events if event["type"] == "final"] == [{
        "type": "final",
        "response": "Example-Branch has three switch access policies.",
    }]


@pytest.mark.asyncio
async def test_code_exec_stream_never_replays_input_history_as_final():
    """The code-exec bridge applies the same new-output-only boundary."""
    history_id = "history-assistant-1"

    async def mock_astream(input_data, config, stream_mode):
        yield ("updates", {"agent": {"messages": [AIMessage(
            content="Understood — I'll use that established context.",
            id=history_id,
        )]}})
        yield ("updates", {"agent": {"messages": [AIMessage(
            content="Example-Branch has three switch access policies.",
            id="new-answer",
        )]}})

    input_data = {"messages": [
        AIMessage(
            content="Understood — I'll use that established context.",
            id=history_id,
        ),
        HumanMessage(content="List Example-Branch access policies"),
    ]}
    mock_graph = MagicMock()
    mock_graph.astream = mock_astream
    events = []

    await run_and_stream_code_exec(mock_graph, input_data, {}, events.append)

    assert [event for event in events if event["type"] == "final"] == [{
        "type": "final",
        "response": "Example-Branch has three switch access policies.",
    }]


# --- Grader status parsing (RubricMiddleware GraderResponse) ---------------

from ccie_sidecar.agents.deepagents_stream import (
    _parse_grader_result,
    _format_grader_status,
)


def test_parse_grader_satisfied():
    content = (
        "Returning structured response: result='satisfied' "
        "explanation='All good.' "
        "criteria=[{'name': 'List real data', 'passed': True}, "
        "{'name': 'Single answer', 'passed': True}]"
    )
    g = _parse_grader_result(content)
    assert g["verdict"] == "satisfied"
    assert g["passed"] == 2 and g["total"] == 2
    status = _format_grader_status(g)
    assert "Grading passed" in status
    assert "2/2 criteria" in status


def test_parse_grader_needs_revision_with_gap():
    content = (
        "Returning structured response: result='needs_revision' "
        "explanation='Missing verify step.' "
        "criteria=[{'name': 'CHANGE verification', 'passed': False, "
        "'gap': 'never verified with a fresh GET'}, "
        "{'name': 'List real data', 'passed': True}]"
    )
    g = _parse_grader_result(content)
    assert g["verdict"] == "needs_revision"
    assert g["passed"] == 1 and g["total"] == 2
    status = _format_grader_status(g)
    assert "needs revision" in status
    assert "never verified" in status  # the gap surfaces


def test_parse_grader_ignores_non_grader_content():
    assert _parse_grader_result("just some tool output") is None
    assert _parse_grader_result("") is None


@pytest.mark.asyncio
async def test_code_exec_stream_surfaces_grader_status():
    """The code-exec stream (Meraki path) must turn a GraderResponse ToolMessage
    into a clean grader status event, not a raw 'Returning structured response'."""
    grader_content = (
        "Returning structured response: result='satisfied' "
        "explanation='All good.' "
        "criteria=[{'name': 'List real data', 'passed': True}, "
        "{'name': 'Single answer', 'passed': True}]"
    )

    async def mock_astream(input_data, config, stream_mode):
        yield ("updates", {"tools": {"messages": [
            ToolMessage(content=grader_content, tool_call_id="g1", name="GraderResponse")
        ]}})
        yield ("updates", {"agent": {"messages": [
            AIMessage(content="Here are your devices.")
        ]}})

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream

    events = []
    await run_and_stream_code_exec(mock_graph, {}, {}, events.append)

    # The grader ToolMessage must become a code_result carrying structured metrics,
    # not the raw blob.
    grader_events = [e for e in events if e.get("grader")]
    assert len(grader_events) == 1
    g = grader_events[0]["grader"]
    assert g["verdict"] == "satisfied" and g["passed"] == 2
    assert "Grading passed" in grader_events[0]["output"]
    assert "Returning structured response" not in grader_events[0]["output"]
    # The final device answer still comes through.
    assert any(e["type"] == "final" for e in events)


@pytest.mark.asyncio
async def test_run_and_stream_grader_from_toolcall_args():
    """run_and_stream must surface the grader verdict that rides in the
    GraderResponse tool_call ARGS (response_format tool), with metrics."""
    from ccie_sidecar.agents.deepagents_stream import run_and_stream

    async def mock_astream(input_data, config, stream_mode, **kwargs):
        yield ("updates", {"agent": {"messages": [AIMessage(
            content="",
            tool_calls=[{
                "name": "GraderResponse",
                "args": {
                    "result": "satisfied",
                    "explanation": "All criteria pass.",
                    "criteria": [
                        {"name": "List real data", "passed": True},
                        {"name": "Single answer", "passed": True},
                    ],
                },
                "id": "grade_1",
            }],
        )]}})

    mock_graph = MagicMock()
    mock_graph.astream = mock_astream

    events = []
    await run_and_stream(mock_graph, {}, {}, events.append)

    grader_events = [e for e in events if e.get("grader")]
    assert len(grader_events) == 1
    assert grader_events[0]["grader"]["verdict"] == "satisfied"
    assert grader_events[0]["grader"]["passed"] == 2
    assert grader_events[0]["name"] == "GraderResponse"
    assert "Grading passed" in grader_events[0]["result"]
    # It must NOT also emit a bare tool_call named GraderResponse.
    assert not any(e.get("type") == "tool_call" and e.get("name") == "GraderResponse"
                   for e in events)
