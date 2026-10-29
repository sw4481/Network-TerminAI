"""Canvas must not settle a draft while the existing rubric is still reviewing it."""

from unittest.mock import MagicMock

import pytest
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage

from ccie_sidecar.agents.deepagents_stream import run_and_stream
from ccie_sidecar.agents import deepagents_runtime as runtime
from .test_investigation_review import _GraderModel, _verdict
from ccie_sidecar.agents.code_exec import _CanvasTurn


def _canvas_turn():
    turn = _CanvasTurn({"workspace_id": "synthetic-workspace", "run_id": "synthetic-run"}, lambda event: None, ())
    turn.context.finish_presentation = MagicMock(wraps=turn.context.finish_presentation)
    return turn


@pytest.mark.asyncio
@pytest.mark.parametrize("stream_output", [False, True])
async def test_real_review_loop_emits_only_revised_canvas_final(monkeypatch, stream_output):
    grader = _GraderModel(responses=[
        _verdict("needs_revision", False, "Withdraw the unsupported diagnosis."),
        _verdict("satisfied", True),
    ])
    monkeypatch.setattr(runtime, "_build_grader_model", lambda config: grader)
    model = _GraderModel(responses=[
        AIMessage(content="All missing values prove device failure."),
        AIMessage(content="No failure is confirmed; the missing values are unassessed."),
    ])
    graph = create_agent(model, middleware=[runtime._rubric_middleware({})])
    turn = _canvas_turn()
    graph._ccie_canvas_turn = turn
    events = []
    outcome = await run_and_stream(graph, {
        "messages": [HumanMessage(content="Read-only investigation.")],
        "rubric": runtime.TASK_COMPLETION_RUBRIC,
    }, {}, events.append, stream_output=stream_output)
    assert not any(e["type"] == "token" for e in events)
    assert [e["response"] for e in events if e["type"] == "final"] == [
        "No failure is confirmed; the missing values are unassessed."
    ]
    assert outcome["final_emitted"] is True
    turn.context.finish_presentation.assert_called_once()


@pytest.mark.asyncio
async def test_real_review_exhaustion_is_not_canvas_success(monkeypatch):
    grader = _GraderModel(responses=[_verdict("needs_revision", False, "Withdraw the unsupported diagnosis.")])
    monkeypatch.setattr(runtime, "_build_grader_model", lambda config: grader)
    graph = create_agent(_GraderModel(responses=[AIMessage(content="Unsupported conclusion.")]),
                         middleware=[runtime._rubric_middleware({})])
    graph._ccie_canvas_turn = _canvas_turn()
    events = []
    outcome = await run_and_stream(graph, {
        "messages": [HumanMessage(content="Read-only investigation.")],
        "rubric": runtime.TASK_COMPLETION_RUBRIC,
    }, {}, events.append)
    assert outcome["error_kind"] == "answer_review"
    assert outcome["final_emitted"] is False
    assert not any(e["type"] == "final" for e in events)


@pytest.mark.asyncio
@pytest.mark.parametrize("review_result", [
    "max_iterations_reached", "failed", "grader_error", None,
])
async def test_unapproved_canvas_draft_does_not_complete(review_result):
    events = []

    class Graph:
        _ccie_canvas_turn = _canvas_turn()

        async def astream(self, input_data, config, **kwargs):
            yield (), "custom", {"type": "rubric_evaluation_start"}
            yield (), "updates", {"model": {"messages": [AIMessage(content="Unapproved draft.")]}}
            assert not any(e["type"] == "final" for e in events)
            if review_result is not None:
                yield (), "updates", {"RubricMiddleware.after_agent": {
                    "_rubric_status": review_result,
                }}

    outcome = await run_and_stream(Graph(), {"rubric": "Evidence check"}, {}, events.append)
    assert outcome["final_emitted"] is False
    assert outcome["error_kind"] == "answer_review"
    assert not any(e["type"] == "final" for e in events)
    assert any(e["type"] == "error" and e["kind"] == "answer_review" for e in events)


@pytest.mark.asyncio
async def test_canvas_draft_is_not_final_when_graph_errors_after_it():
    class Graph:
        _ccie_canvas_turn = _canvas_turn()

        async def astream(self, input_data, config, **kwargs):
            yield (), "updates", {"model": {"messages": [AIMessage(content="Draft before failure.")]}}
            raise ValueError("Review transport failed")

    events = []
    outcome = await run_and_stream(Graph(), {"rubric": "Evidence check"}, {}, events.append)
    assert outcome["final_emitted"] is False
    assert not any(e["type"] == "final" for e in events)
    assert any(e["type"] == "error" for e in events)


@pytest.mark.asyncio
async def test_non_canvas_stream_keeps_existing_final_behavior():
    class Graph:
        async def astream(self, input_data, config, **kwargs):
            yield (), "updates", {"model": {"messages": [AIMessage(content="Ordinary chat.")]}}

    events = []
    outcome = await run_and_stream(Graph(), {}, {}, events.append)
    assert outcome["final_emitted"] is True
    assert [e["response"] for e in events if e["type"] == "final"] == ["Ordinary chat."]
