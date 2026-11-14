"""Canvas cannot certify final-answer text hidden by the grader's existing bound."""

import pytest
from deepagents.middleware.rubric import _MAX_TRANSCRIPT_CHARS_PER_MESSAGE
from langchain.agents import create_agent
from langchain_core.messages import AIMessage, HumanMessage

from ccie_sidecar.agents import deepagents_runtime as runtime
from ccie_sidecar.agents.code_exec import CANVAS_PRESENTATION_GUIDANCE
from ccie_sidecar.agents.deepagents_stream import run_and_stream
from .test_canvas_review_finalization import _canvas_turn
from .test_investigation_review import _GraderModel, _verdict


def test_canvas_guidance_keeps_full_records_in_cards_and_summary_reviewable():
    assert _MAX_TRANSCRIPT_CHARS_PER_MESSAGE == 4000
    assert "at most 4000 characters" in CANVAS_PRESENTATION_GUIDANCE
    assert "row-by-row details in cards" in CANVAS_PRESENTATION_GUIDANCE
    for requirement in ("population", "window", "counts", "conclusion", "unknowns", "conditional next steps"):
        assert requirement in CANVAS_PRESENTATION_GUIDANCE


@pytest.mark.asyncio
@pytest.mark.parametrize("length", [3999, 4000, 4001])
async def test_canvas_requires_entire_final_to_fit_actual_review_bound(monkeypatch, length):
    grader = _GraderModel(responses=[_verdict("satisfied", True)])
    monkeypatch.setattr(runtime, "_build_grader_model", lambda config: grader)
    answer = "x" * 3999 + "!" * (length - 3999)
    graph = create_agent(
        _GraderModel(responses=[AIMessage(content=answer)]),
        middleware=[runtime._rubric_middleware({})],
    )
    graph._ccie_canvas_turn = _canvas_turn()
    events = []
    outcome = await run_and_stream(graph, {
        "messages": [HumanMessage(content="Read-only investigation.")],
        "rubric": runtime.TASK_COMPLETION_RUBRIC,
    }, {}, events.append)
    finals = [event for event in events if event["type"] == "final"]
    if length <= _MAX_TRANSCRIPT_CHARS_PER_MESSAGE:
        assert outcome["final_emitted"] is True
        assert [event["response"] for event in finals] == [answer]
    else:
        assert outcome["final_emitted"] is False
        assert outcome["error_kind"] == "answer_review"
        assert not finals
        assert any(event["type"] == "error" for event in events)
