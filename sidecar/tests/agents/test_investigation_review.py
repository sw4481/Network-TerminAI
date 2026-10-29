"""Investigation review uses the existing bounded revision loop, not a new agent."""

import pytest
from deepagents.middleware.rubric import GRADER_SYSTEM_PROMPT
from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage, HumanMessage
from langgraph.runtime import Runtime

from ccie_sidecar.agents import deepagents_runtime as runtime


class _GraderModel(FakeMessagesListChatModel):
    def bind_tools(self, tools, **kwargs):
        return self


def _verdict(result, passed, gap=None):
    criterion = {"name": "Evidence-bounded conclusions", "passed": passed}
    if gap:
        criterion["gap"] = gap
    return AIMessage(content="", tool_calls=[{
        "name": "GraderResponse",
        "id": f"synthetic-{result}",
        "args": {
            "result": result,
            "explanation": "Conclusions must match the retrieved scope.",
            "criteria": [criterion],
        },
    }])


def test_grader_preserves_builtin_verdict_and_untrusted_transcript_rules(monkeypatch):
    model = _GraderModel(responses=[_verdict("satisfied", True)])
    monkeypatch.setattr(runtime, "_build_grader_model", lambda config: model)
    middleware = runtime._rubric_middleware({})
    assert middleware._system_prompt == GRADER_SYSTEM_PROMPT
    assert middleware.max_iterations == 2


def test_fixable_answer_errors_request_revision_not_terminal_failure():
    assert "Grade 'needs_revision'" in runtime.TASK_COMPLETION_RUBRIC
    assert "Grade 'failed' with specific feedback" not in runtime.TASK_COMPLETION_RUBRIC
    assert "malformed or impossible to evaluate" in runtime.TASK_COMPLETION_RUBRIC


@pytest.mark.parametrize("requirement", [
    "same retained rows",
    "record caps",
    "queried population",
    "headline",
    "policy",
])
def test_author_and_reviewer_share_evidence_requirements(requirement):
    assert requirement in runtime.ARCHITECT_EXECUTION_CONTRACT
    assert requirement in runtime.TASK_COMPLETION_RUBRIC


def test_platform_mismatch_is_also_revisable():
    rubric = runtime._platform_aware_rubric("find ISE endpoint issues", ["ise"])
    platform_clause = rubric.split("PLATFORM MATCH:", 1)[1]
    assert "'needs_revision'" in platform_clause
    assert "'failed'" not in platform_clause


def test_real_middleware_revises_then_accepts_without_changing_request(monkeypatch):
    model = _GraderModel(responses=[
        _verdict("needs_revision", False, "Narrow the headline; do not infer faults from state alone."),
        _verdict("satisfied", True),
    ])
    monkeypatch.setattr(runtime, "_build_grader_model", lambda config: model)
    middleware = runtime._rubric_middleware({})
    request = HumanMessage(content="Read-only: find endpoint issues.")
    state = {
        "rubric": runtime.TASK_COMPLETION_RUBRIC,
        "messages": [request, AIMessage(content="No failures anywhere.")],
    }
    update = middleware.after_agent(state, Runtime())
    assert update["jump_to"] == "model"
    assert update["_rubric_status"] == "needs_revision"
    feedback = update["messages"][0]
    assert "Narrow the headline" in feedback.content
    assert feedback.additional_kwargs["lc_source"] == "rubric_grader"
    assert state["messages"][0] is request

    revised = {
        **state, **update,
        "messages": [*state["messages"], feedback,
                     AIMessage(content="No failures found in the retrieved subset; other endpoints unassessed.")],
    }
    final = middleware.after_agent(revised, Runtime())
    assert final["_rubric_status"] == "satisfied"
    assert "jump_to" not in final
    assert final["_rubric_iterations"] == 2


def test_real_middleware_keeps_existing_revision_bound(monkeypatch):
    model = _GraderModel(responses=[
        _verdict("needs_revision", False, "The scope is still overstated."),
    ])
    monkeypatch.setattr(runtime, "_build_grader_model", lambda config: model)
    middleware = runtime._rubric_middleware({})
    update = middleware.after_agent({
        "rubric": runtime.TASK_COMPLETION_RUBRIC,
        "_rubric_iterations": 1,
        "messages": [HumanMessage(content="Read-only investigation."),
                     AIMessage(content="An unsupported conclusion.")],
    }, Runtime())
    assert update["_rubric_status"] == "max_iterations_reached"
    assert "jump_to" not in update
