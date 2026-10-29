"""Collection blockers stay visible without changing API execution or evidence."""
import json
from pathlib import Path

import pytest

from ccie_sidecar.agents.code_exec import _capture_canvas_result, _install_canvas
from ccie_sidecar.agents.copilot_canvas import CanvasContext
from ccie_sidecar.agents.catalog_grounding import CatalogIndex

REQUEST = {"workspace_id": "synthetic-workspace", "run_id": "synthetic-run"}


@pytest.mark.parametrize("failure", [
    {"status_code": 0, "data": None, "error": "private-upstream-value"},
    json.dumps({"status_code": 403, "data": None, "error": "private-upstream-value"}),
    {"status_code": 500, "data": None, "error": "private-upstream-value"},
])
def test_failed_source_returns_emit_partial_coverage_once_and_keep_success(failure):
    events, calls = [], []
    canvas = CanvasContext(REQUEST, events.append, ())
    good = {"status_code": 200, "data": {"count": 7}, "error": None}

    def helper(method, path):
        calls.append((method, path))
        return good if path == "/good" else failure

    sandbox = {"synthetic_api_call": helper}
    _install_canvas(sandbox, canvas)
    assert sandbox["synthetic_api_call"]("GET", "/good") is good
    assert events == []
    assert sandbox["synthetic_api_call"]("GET", "/blocked") is failure
    assert sandbox["synthetic_api_call"]("GET", "/blocked") is failure
    coverage = [event for event in events if event["kind"] == "coverage"]
    assert len(coverage) == 1
    assert coverage[0]["payload"]["collection_status"] == "partial"
    assert coverage[0]["payload"]["failed_helpers"] == ["synthetic_api_call"]
    assert "private-upstream-value" not in json.dumps(events)
    assert (coverage[0]["workspace_id"], coverage[0]["run_id"]) == tuple(REQUEST.values())
    assert any(snapshot["data"] == good for snapshot in canvas.snapshots.values())
    assert calls == [("GET", "/good"), ("GET", "/blocked"), ("GET", "/blocked")]
    canvas.publish({"type": "text", "title": "Retained result", "metadata": {"body": "Seven observed"}})
    canvas.finish_presentation()
    assert events[-1]["kind"] == "card"


def test_raised_source_failure_preserves_original_exception_and_reports_partial():
    events = []
    canvas = CanvasContext(REQUEST, events.append, ())
    error = ValueError("private-upstream-value")

    def helper(*args):
        raise error

    sandbox = {"synthetic_api_call": helper}
    _install_canvas(sandbox, canvas)
    with pytest.raises(ValueError) as caught:
        sandbox["synthetic_api_call"]("GET", "/blocked")
    assert caught.value is error
    assert events[0]["kind"] == "coverage"
    assert events[0]["payload"]["collection_status"] == "partial"
    assert "private-upstream-value" not in json.dumps(events)


def test_canvas_delivery_failure_never_changes_source_success_or_exception():
    def disconnected(event):
        raise RuntimeError("synthetic disconnected renderer")

    canvas = CanvasContext(REQUEST, disconnected, ())
    success = {"status_code": 200, "data": {"count": 7}}
    error = ValueError("source failed")

    def helper(method, path):
        if path == "/blocked":
            raise error
        return success

    sandbox = {"synthetic_api_call": helper}
    _install_canvas(sandbox, canvas)
    assert sandbox["synthetic_api_call"]("GET", "/good") is success
    with pytest.raises(ValueError) as caught:
        sandbox["synthetic_api_call"]("GET", "/blocked")
    assert caught.value is error


def test_execution_output_is_not_misclassified_as_an_api_failure():
    events = []
    canvas = CanvasContext(REQUEST, events.append, ())
    _capture_canvas_result(canvas, "execute_python_code", '{"status_code":500,"error":"text"}', origin="execution_output")
    assert events == []


def test_bundled_ise_history_is_discoverable_and_authorizes_only_documented_template():
    bundle = Path(__file__).resolve().parents[3] / "bundled-agents" / "ise" / "tools.json"
    index = CatalogIndex([{"id": "ise", "entries": json.loads(bundle.read_text())}])
    found = index.search("AuthStatus authentication history", catalog_id="ise")
    assert "AuthStatus/MACAddress" in json.dumps(found)
    index.require_authorized("ise", "GET", "/admin/API/mnt/AuthStatus/MACAddress/00:11:22:33:44:55/3600/10/All")
