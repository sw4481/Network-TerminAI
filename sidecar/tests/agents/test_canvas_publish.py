"""Display-ready Canvas contracts; synthetic values, real factories, no services."""
import copy
import json

import pytest

from ccie_sidecar.agents.copilot_canvas import CanvasContext
from .test_copilot_canvas_runtime import isolated_helpers, REQUEST


PUBLICATIONS = [
    {"type": "text", "title": "Note", "metadata": {"body": "Agent-authored note"}},
    {"type": "table", "title": "Inventory", "metadata": {
        "columns": [{"key": "a/b~c", "label": "Value"}],
        "rows": [{"cells": {"a/b~c": {"nested": [0, False, None]}}}],
    }},
    {"type": "key_value", "title": "Summary", "metadata": {
        "fields": [{"label": "Count", "value": 0}],
    }},
    *[{"type": "chart", "title": "Counts", "metadata": {
        "form": form, "x_label": "Group", "y_label": "Count",
        "points": [{"label": "Group A", "value": 2}, {"label": 1, "value": 0}],
    }} for form in ("bar", "line")],
    {"type": "topology", "title": "Proposed graph", "metadata": {
        "nodes": [{"id": "a"}, {"id": 1}], "links": [{"from": "a", "to": 1}],
    }},
    {"type": "findings", "title": "Interpretation", "metadata": {"findings": [{
        "device": "switch-a", "interface": "port-1", "symptom": "Review required",
        "severity": "warning", "cause_assessment": "undetermined",
        "unknowns": ["Cause not established"], "remediation_considerations": ["Inspect before changes"],
    }]}},
    {"type": "assessment", "title": "Unassessed", "metadata": {
        "narrative": "Coverage is incomplete", "unknowns": ["Interface not assessed"],
        "remediation_considerations": [],
    }},
]


@pytest.mark.parametrize("original", PUBLICATIONS, ids=lambda spec: spec["type"] + spec["metadata"].get("form", ""))
def test_publish_display_values_without_model_references(original):
    events = []
    canvas = CanvasContext(REQUEST, events.append, ())
    observed = canvas.capture({"helper": "synthetic"}, {"original": "still inspectable"}, call_id="observed")
    spec = copy.deepcopy(original)
    result = canvas.publish(spec)
    assert result["type"] == spec["type"] and spec == original
    assert len(events) == 1 and events[0]["kind"] == "card"
    snapshots = events[0]["payload"]["snapshots"]
    assert len(snapshots) == 1 and snapshots[0]["origin"] == "agent_authored"
    assert snapshots[0]["data"] == original["metadata"]
    assert snapshots[0]["evidence_id"] != observed
    assert canvas.inspect({"evidence_id": observed, "path": "/original"})["preview"] == '"still inspectable"'
    assert result["source_refs"] == [{"evidence_id": snapshots[0]["evidence_id"], "path": ""}]
    if spec["type"] == "table":
        ref = result["metadata"]["rows"][0]["cells"]["a/b~c"]
        assert ref["path"] == "/rows/0/cells/a~1b~0c"
        assert json.loads(canvas.inspect(ref)["preview"]) == {"nested": [0, False, None]}
    if spec["type"] in {"assessment", "findings"}:
        metadata = result["metadata"] if spec["type"] == "assessment" else result["metadata"]["findings"][0]
        assert metadata["supporting_refs"] == [] and metadata["contradictory_refs"] == []


INVALID = [
    {"type": "html", "title": "No", "metadata": {"body": "<script>bad()</script>"}},
    {**PUBLICATIONS[0], "source_refs": []},
    {"type": "text", "title": "No", "metadata": {"body": {"executable": "bad()"}}},
    {"type": "table", "title": "No", "metadata": {"columns": [{"key": "x", "label": "X"}], "rows": [{"cells": {"y": 1}}]}},
    {"type": "table", "title": "No", "metadata": {"columns": [{"key": "x", "label": "X"}], "rows": []}},
    {"type": "table", "title": "No", "metadata": {"columns": [{"key": "x", "label": "X"}] * 2, "rows": [{"cells": {"x": 1}}]}},
    *[{"type": "chart", "title": "No", "metadata": {"form": "bar", "x_label": "X", "y_label": "Y", "points": [{"label": "a", "value": value}]}} for value in (True, "2", float("nan"), float("inf"), -float("inf"))],
    {"type": "topology", "title": "No", "metadata": {"nodes": [{"id": "a"}], "links": [{"from": "a", "to": "missing"}]}},
    {"type": "topology", "title": "No", "metadata": {"nodes": [{"id": "a"}, {"id": "a"}], "links": []}},
    {"type": "topology", "title": "No", "metadata": {"nodes": [{"id": 1}, {"id": 1.0}], "links": []}},
    {"type": "topology", "title": "No", "metadata": {"nodes": [{"id": True}], "links": []}},
    {"type": "assessment", "title": "No", "metadata": {**PUBLICATIONS[-1]["metadata"], "supporting_refs": []}},
    {"type": "findings", "title": "No", "metadata": {"findings": [{**PUBLICATIONS[-2]["metadata"]["findings"][0], "interface": None}]}},
]


@pytest.mark.parametrize("spec", INVALID)
def test_publish_rejects_invalid_display_schemas_and_nonfinite_json(spec):
    events = []
    canvas = CanvasContext(REQUEST, events.append, ())
    assert canvas.publish(copy.deepcopy(spec))["kind"] == "warning"
    assert not any(event["kind"] == "card" for event in events)


def test_publish_redacts_and_keeps_scope_without_claiming_observed_support():
    events, other_events = [], []
    canvas = CanvasContext(REQUEST, events.append, ("known-sensitive-value",))
    other = CanvasContext({"workspace_id": "other-workspace", "run_id": "other-run"}, other_events.append, ())
    spec = {"type": "key_value", "title": "known-sensitive-value", "metadata": {
        "fields": [{"label": "known-sensitive-value", "value": {"password": "hidden", "note": "known-sensitive-value"}}],
    }}
    result = canvas.publish(spec)
    assert result["title"] == "[REDACTED]"
    encoded = json.dumps(events)
    assert "known-sensitive-value" not in encoded and "hidden" not in encoded
    assert other_events == [] and other.snapshots == {}
    assert all(snapshot["origin"] == "agent_authored" for snapshot in canvas.snapshots.values())
    assert other.present(result)["kind"] == "warning"


def test_publish_uses_existing_size_bound_and_preserves_failed_delivery():
    from ccie_sidecar.agents.tool_output import DEFAULT_MAX_RETAINED_BYTES
    events = []
    canvas = CanvasContext(REQUEST, events.append, ())
    oversized = {"type": "text", "title": "Large", "metadata": {"body": "x" * DEFAULT_MAX_RETAINED_BYTES}}
    assert canvas.publish(oversized)["kind"] == "warning"
    assert not any(event["kind"] == "card" for event in events)
    def reject(event):
        if event["kind"] == "card":
            raise RuntimeError("synthetic disconnected renderer")
        events.append(event)
    failed = CanvasContext(REQUEST, reject, ())
    assert failed.publish(PUBLICATIONS[0])["kind"] == "warning"
    failed.finish_presentation()
    assert "no validated cards" in events[-1]["payload"]["limitation"]


@pytest.mark.parametrize("spec", PUBLICATIONS, ids=lambda spec: spec["type"] + spec["metadata"].get("form", ""))
def test_native_publishing_schema_and_handler_accept_actual_values(spec):
    from ccie_sidecar.agents.deepagents_tools import create_canvas_tools
    events = []
    tools = create_canvas_tools(CanvasContext(REQUEST, events.append, ()), publishing=True)
    assert [tool.name for tool in tools] == ["canvas_publish"]
    tool = tools[0]
    schema = tool.tool_call_schema.model_json_schema()
    assert set(schema["properties"]) == {"type", "title", "metadata"}
    # LangChain's tool-call projection drops root config; actual input validation stays closed.
    assert tool.args_schema.model_json_schema()["additionalProperties"] is False
    assert "evidence_id" not in json.dumps(schema) and '"path"' not in json.dumps(schema)
    assert tool.args_schema.model_validate(spec).model_dump(by_alias=True) == spec
    assert tool.invoke(copy.deepcopy(spec))["status"] == "presented"
    assert events[0]["payload"]["snapshots"][0]["origin"] == "agent_authored"


def test_native_publishing_validation_is_safe_and_presentation_only(capsys):
    from ccie_sidecar.agents.deepagents_tools import create_canvas_tools
    events = []
    canvas = CanvasContext(REQUEST, events.append, ("private-marker",))
    tool = create_canvas_tools(canvas, publishing=True)[0]
    response = tool.invoke({"type": "tool_call", "name": "canvas_publish", "id": "synthetic-publish", "args": {
        **PUBLICATIONS[0], "source_refs": [{"evidence_id": "private-marker", "path": "private-marker"}],
    }})
    assert response.status == "error"
    assert json.loads(response.content)["kind"] == "warning"
    assert "private-marker" not in response.content and "private-marker" not in json.dumps(events)
    assert len(events) == 1 and events[0]["kind"] == "warning"
    assert tool.invoke(PUBLICATIONS[0])["status"] == "presented"
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err == ""


def test_python_publish_facade_and_ordinary_chat_opt_out():
    from ccie_sidecar.agents.deepagents_tools import create_execute_python_code_tool
    events = []
    canvas = CanvasContext(REQUEST, events.append, ())
    tool = create_execute_python_code_tool(None, {}, events.append, canvas=canvas)
    result = tool.invoke({"code": f"card = canvas.publish({PUBLICATIONS[3]!r})\nprint(card['type'])"})
    assert result == "chart\n"
    assert events[0]["payload"]["card"]["type"] == "chart"
    ordinary = create_execute_python_code_tool(None, {}, events.append)
    assert ordinary.invoke({"code": "print('canvas' in globals())"}) == "False\n"


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["valid", "invalid_metadata", "unavailable", "no_presentation", "ordinary"])
async def test_actual_runtime_publishing_delivers_or_recovers_without_replaying_source(monkeypatch, mode):
    from langchain.agents.middleware import AgentMiddleware
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import AIMessage, ToolMessage
    from langchain_core.outputs import ChatGeneration, ChatResult
    from ccie_sidecar import agent, meraki
    from ccie_sidecar.agents import architect_subagents as architect, deepagents_runtime as runtime
    monkeypatch.setattr(architect, "VENDOR_SPECS", [{"id": "meraki", "configured": lambda: True, "display": "Meraki", "when": "synthetic"}])
    calls, results = [], []
    def helper(*args):
        calls.append(args)
        return {"count": 2}
    monkeypatch.setattr(meraki, "install_meraki", lambda g, **kwargs: g.update(meraki_api_call=helper))
    bound_names = set()
    class Model(BaseChatModel):
        @property
        def _llm_type(self):
            return "synthetic-values-publishing"
        def bind_tools(self, tools, **kwargs):
            bound_names.update(tool.name for tool in tools)
            return self
        def _generate(self, messages, stop=None, run_manager=None, **kwargs):
            results[:] = [message for message in messages if isinstance(message, ToolMessage)]
            publications = [message for message in results if message.name == "canvas_publish"]
            if not results:
                message = AIMessage(content="", tool_calls=[{"name": "execute_python_code", "args": {
                    "code": "print(meraki_api_call('GET', '/counts'))"}, "id": "synthetic-read"}])
            elif mode not in {"ordinary", "no_presentation"} and (not publications or mode == "invalid_metadata" and len(publications) == 1):
                spec = copy.deepcopy(PUBLICATIONS[4])
                if mode == "invalid_metadata" and not publications:
                    spec["source_refs"] = []
                message = AIMessage(content="", tool_calls=[{"name": "canvas_publish", "args": spec, "id": f"synthetic-chart-{len(publications)}"}])
            else:
                message = AIMessage(content="Normal chat answer; chart is agent-authored.")
            return ChatResult(generations=[ChatGeneration(message=message)])
    monkeypatch.setattr(agent, "get_saved_config", lambda: {"provider": "openai", "model": "synthetic"})
    monkeypatch.setattr(runtime, "build_chat_model", lambda config: Model())
    monkeypatch.setattr(runtime, "_rubric_middleware", lambda config: AgentMiddleware())
    monkeypatch.setattr("ccie_sidecar.agents.catalog_grounding.resolve_agent_catalogs", lambda definition: [])
    events = []
    def deliver(event):
        if mode == "unavailable" and event.get("type") == "canvas" and event["kind"] == "card":
            raise RuntimeError("synthetic renderer unavailable")
        events.append(event)
    outcome = await runtime.deepagents_react_code_loop(
        {"agent_id": "network-architect"}, "Show a chart",
        {"run_id": "publishing-runtime", **({} if mode == "ordinary" else {"canvas": REQUEST})}, deliver,
    )
    assert outcome["final_emitted"] is True and outcome.get("error_kind") is None
    assert ("canvas_publish" in bound_names) is (mode != "ordinary")
    assert not ({"canvas_present", "canvas_sources"} & bound_names)
    assert calls == [("GET", "/counts")], "presentation must not repeat source operations"
    cards = [event for event in events if event["type"] == "canvas" and event["kind"] == "card"]
    if mode in {"valid", "invalid_metadata"}:
        assert len(cards) == 1 and cards[0]["payload"]["card"]["type"] == "chart"
        assert cards[0]["payload"]["snapshots"][0]["origin"] == "agent_authored"
    else:
        assert cards == []
    if mode == "invalid_metadata":
        publications = [message for message in results if message.name == "canvas_publish"]
        assert [message.status for message in publications] == ["error", "success"]
    if mode in {"unavailable", "no_presentation"}:
        assert any(event.get("kind") == "warning" and "no validated cards" in event["payload"]["limitation"] for event in events)
    if mode == "ordinary":
        assert not any(event["type"] == "canvas" for event in events)
    assert events[-1]["type"] == "final"
    assert events[-1]["response"] == "Normal chat answer; chart is agent-authored."
