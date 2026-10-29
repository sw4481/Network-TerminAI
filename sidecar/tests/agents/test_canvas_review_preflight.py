"""Oversized Canvas drafts must be revisable within the existing review budget."""

from unittest.mock import MagicMock

import pytest
from deepagents import RubricMiddleware
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage

from ccie_sidecar.agents import deepagents_runtime as runtime
from ccie_sidecar.agents.deepagents_stream import run_and_stream
from .test_canvas_review_finalization import _canvas_turn
from .test_investigation_review import _GraderModel, _verdict


def _graph(monkeypatch, answers, verdict="satisfied", canvas=True):
    grader = _GraderModel(responses=[_verdict(verdict, verdict == "satisfied", "Narrow unsupported claims.")])
    monkeypatch.setattr(runtime, "_build_grader_model", lambda config: grader)
    middleware = runtime._rubric_middleware({})
    middleware.canvas = canvas
    ensure_grader = MagicMock(wraps=middleware._ensure_grader)
    monkeypatch.setattr(middleware, "_ensure_grader", ensure_grader)
    graph = create_agent(_GraderModel(responses=answers), middleware=[middleware])
    if canvas:
        graph._ccie_canvas_turn = _canvas_turn()
    return graph, middleware, ensure_grader


def _input():
    return {"messages": [HumanMessage(content="Read-only investigation.")],
            "rubric": runtime.TASK_COMPLETION_RUBRIC}


@pytest.mark.asyncio
@pytest.mark.parametrize("sync", [False, True])
@pytest.mark.parametrize("blocks", [False, True])
async def test_oversized_final_revises_before_external_grading(monkeypatch, sync, blocks):
    content = [{"type": "text", "text": "x" * 4001}] if blocks else "x" * 4001
    compact = "No failure is confirmed in the retrieved subset; remaining endpoints are unassessed."
    graph, middleware, ensure_grader = _graph(monkeypatch, [AIMessage(content=content), AIMessage(content=compact)])
    updates = list(graph.stream(_input(), stream_mode="updates")) if sync else [
        update async for update in graph.astream(_input(), stream_mode="updates")
    ]
    reviews = [u["RubricMiddleware.after_agent"] for u in updates if "RubricMiddleware.after_agent" in u]
    answers = [u["model"]["messages"][-1] for u in updates if "model" in u]
    assert middleware.name == "RubricMiddleware"
    assert middleware.max_iterations == 2
    assert reviews[-1]["_rubric_iterations"] == 2
    assert reviews[-1]["_rubric_status"] == "satisfied"
    assert answers[-1].content == compact
    assert answers[0].content == content
    feedback = reviews[0]["messages"][0]
    assert "4001" in feedback.content and "4000" in feedback.content
    assert "rewrite" in feedback.content.lower()
    assert "cards" in feedback.content.lower()
    ensure_grader.assert_called_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("verdict", ["satisfied", "needs_revision"])
async def test_shortened_canvas_final_still_needs_ordinary_review(monkeypatch, verdict):
    compact = "No failure is confirmed in the retrieved subset."
    graph, _, ensure_grader = _graph(monkeypatch, [AIMessage(content="x" * 4001), AIMessage(content=compact)], verdict)
    events = []
    result = await run_and_stream(graph, _input(), {}, events.append, stream_output=True)
    assert not any(e["type"] == "token" for e in events)
    assert result["final_emitted"] is (verdict == "satisfied")
    assert [e["response"] for e in events if e["type"] == "final"] == ([compact] if verdict == "satisfied" else [])
    if verdict != "satisfied":
        assert result["error_kind"] == "answer_review"
    ensure_grader.assert_called_once()


@pytest.mark.asyncio
async def test_repeated_oversize_exhausts_existing_two_attempts(monkeypatch):
    graph, middleware, ensure_grader = _graph(monkeypatch, [AIMessage(content="x" * 4001), AIMessage(content="y" * 4001)])
    events = []
    result = await run_and_stream(graph, _input(), {}, events.append)
    assert middleware.max_iterations == 2
    assert result["final_emitted"] is False
    assert result["error_kind"] == "answer_review"
    assert not any(e["type"] == "final" for e in events)
    ensure_grader.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("length", [3999, 4000])
async def test_reviewable_canvas_final_uses_ordinary_grader(monkeypatch, length):
    graph, _, ensure_grader = _graph(monkeypatch, [AIMessage(content="x" * length)])
    updates = [update async for update in graph.astream(_input(), stream_mode="updates")]
    review = next(u["RubricMiddleware.after_agent"] for u in updates if "RubricMiddleware.after_agent" in u)
    assert review["_rubric_status"] == "satisfied"
    assert review["_rubric_iterations"] == 1
    ensure_grader.assert_called_once()


@pytest.mark.asyncio
async def test_non_canvas_review_keeps_existing_length_behavior(monkeypatch):
    graph, middleware, ensure_grader = _graph(monkeypatch, [AIMessage(content="x" * 4001)], canvas=False)
    assert isinstance(middleware, RubricMiddleware)
    assert middleware.canvas is False
    updates = [update async for update in graph.astream(_input(), stream_mode="updates")]
    review = next(u["RubricMiddleware.after_agent"] for u in updates if "RubricMiddleware.after_agent" in u)
    assert review["_rubric_status"] == "satisfied"
    assert review["_rubric_iterations"] == 1
    ensure_grader.assert_called_once()
