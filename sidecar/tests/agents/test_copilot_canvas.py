"""Synthetic, cross-language contract for turn-scoped Canvas evidence."""
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from ccie_sidecar.agents.copilot_canvas import CanvasContext
from ccie_sidecar.agents.tool_output import DEFAULT_MAX_RETAINED_BYTES

FIXTURE = json.loads(
    (Path(__file__).resolve().parents[3] / "tests/fixtures/copilot_canvas/v1.json").read_text()
)


def context():
    events = []
    return CanvasContext(FIXTURE["request"], events.append, ("known-secret-987",)), events


def test_fixture_all_seven_variants_are_source_bound():
    ctx, events = context()
    ids = {}
    for snapshot in FIXTURE["snapshots"]:
        ids[snapshot["evidence_id"]] = ctx.capture(
            snapshot["source"], snapshot["data"], call_id=snapshot["call_id"])
    for original in FIXTURE["cards"]:
        spec = json.loads(json.dumps(original).replace("evidence-a", ids["evidence-a"]).replace("evidence-b", ids["evidence-b"]))
        result = ctx.present(spec)
        assert result["type"] == spec["type"]
        assert result["workspace_id"] == "canvas-tab-1"
    assert [event["seq"] for event in events] == list(range(1, 8))
    assert {event["payload"]["card"]["type"] for event in events} == {
        "findings", "table", "key_value", "chart", "topology", "text", "assessment"
    }
    assert all(event["payload"]["snapshots"] for event in events)


def test_interleaved_identical_helper_calls_keep_identity_and_pin_references():
    ctx, events = context()
    with ThreadPoolExecutor(max_workers=2) as pool:
        ids = list(pool.map(lambda item: ctx.capture(
            FIXTURE["snapshots"][0]["source"], item[1], call_id=item[0]
        ), [("call-a", {"value": 0}), ("call-b", {"value": False})]))
    assert ids[0] != ids[1]
    assert {snapshot["call_id"] for snapshot in ctx.snapshots.values()} == {"call-a", "call-b"}
    spec = {"type": "text", "title": "Observed", "source_refs": [{"evidence_id": ids[0], "path": "/value"}],
            "metadata": {"body": {"evidence_id": ids[0], "path": "/value"}}}
    assert ctx.present(spec)["type"] == "text"
    for index in range(3):
        ctx.capture({"helper": "large", "arguments": {}}, {"blob": "x" * 900_000}, call_id=f"evict-{index}")
    assert ctx.snapshots[ids[0]]["data"] == {"value": 0}
    assert ids[1] not in ctx.snapshots
    assert events[-1]["payload"]["snapshots"][0]["call_id"] == "call-a" or events[-1]["kind"] == "warning"


def test_registered_helper_config_merges_with_constructor_values_before_capture_and_events():
    ctx, events = context()
    ctx.register_sensitive_config({"password": "vendor-value-123", "nested": [
        {"client_secret": "  client-value-456  "}, {"refresh_token": "refresh-value-789"}],
        "host": "visible-host"})
    assert events == []
    evidence_id = ctx.capture({"helper": "inventory"}, {
        "error": "known-secret-987 vendor-value-123 client-value-456 refresh-value-789",
        "host": "visible-host"}, call_id="safe-call")
    assert ctx.snapshots[evidence_id]["data"] == {
        "error": "[REDACTED] [REDACTED] [REDACTED] [REDACTED]", "host": "visible-host"}
    ref = {"evidence_id": evidence_id, "path": "/error"}
    assert ctx.present({"type": "text", "title": "known-secret-987 vendor-value-123",
                        "source_refs": [ref], "metadata": {"body": ref}})["title"] == "[REDACTED] [REDACTED]"
    for value in ("known-secret-987", "vendor-value-123", "client-value-456", "refresh-value-789"):
        assert value not in json.dumps(events)


def test_late_registration_discards_retained_evidence_without_rewriting_prior_deliveries():
    ctx, events = context()
    value = "late-vendor-value-123"
    evidence_id = ctx.capture({"helper": "inventory"}, {"error": value}, call_id="before-registration")
    ref = {"evidence_id": evidence_id, "path": "/error"}
    spec = {"type": "text", "title": "Prior evidence", "source_refs": [ref], "metadata": {"body": ref}}
    assert ctx.present(spec)["type"] == "text"
    delivered = json.dumps(events[0], sort_keys=True)
    assert value in delivered  # Registration cannot undo an already delivered event.
    ctx.register_sensitive_config({"password": value})
    assert ctx.snapshots == {}
    assert json.dumps(events[0], sort_keys=True) == delivered
    assert events[1]["kind"] == "warning"
    assert "cannot be retroactively redacted" in events[1]["payload"]["limitation"]
    assert value not in json.dumps(events[1:])
    assert ctx.present(spec)["kind"] == "warning"
    assert ctx.derive([ref], 1, "count") is None
    after_id = ctx.capture({"helper": "inventory"}, {"error": value}, call_id="after-registration")
    assert ctx.snapshots[after_id]["data"] == {"error": "[REDACTED]"}
    retained, count = ctx.snapshots, len(events)
    ctx.register_sensitive_config({"password": value})
    assert ctx.snapshots == retained
    assert len(events) == count
    assert value not in json.dumps(events[1:])


def test_registration_blocks_newly_unsafe_identities_before_retention_or_delivery():
    for identity in ("workspace_id", "run_id"):
        request = {**FIXTURE["request"], identity: "contains-new-vendor-value"}
        events = []
        ctx = CanvasContext(request, events.append, ())
        evidence_id = ctx.capture({"helper": "inventory"}, {"ok": True}, call_id="before")
        ref = {"evidence_id": evidence_id, "path": "/ok"}
        ctx.register_sensitive_config({"password": "new-vendor-value"})
        assert events == []
        assert ctx.snapshots == {}
        assert ctx.capture({"helper": "inventory"}, {"ok": True}, call_id="after") is None
        assert ctx.derive([ref], 1, "count") is None
        result = ctx.present({"type": "text", "title": "No delivery", "source_refs": [ref], "metadata": {"body": ref}})
        assert result["kind"] == "warning"
        assert "new-vendor-value" not in json.dumps(result)
        assert events == []
        assert ctx.snapshots == {}


def test_redaction_preserves_json_shape_and_exception_text():
    ctx, _ = context()
    evidence_id = ctx.capture(
        {"helper": "inventory", "arguments": {"headers": {"Authorization": "Bearer known-secret-987"}, "site": "lab"}},
        {"children": [{"api_key": "danger", "nested": [{"password": "danger", "good": "known-secret-987"}]}],
         "error": "Exception: known-secret-987\nBearer known-secret-987"}, call_id="secret")
    saved = ctx.snapshots[evidence_id]
    serialized = json.dumps(saved)
    assert "known-secret-987" not in serialized
    assert "danger" not in serialized
    assert "Bearer known-secret-987" not in serialized
    assert saved["data"]["children"][0]["api_key"] == "[REDACTED]"
    assert saved["data"]["children"][0]["nested"][0]["password"] == "[REDACTED]"
    assert saved["data"]["children"][0]["nested"][0]["good"] == "[REDACTED]"
    assert saved["source"]["arguments"]["headers"] == "[REDACTED]"


def test_over_limit_and_invalid_pointers_cannot_claim_complete_data():
    ctx, events = context()
    huge = ctx.capture({"helper": "inventory"}, {"devices": ["x" * DEFAULT_MAX_RETAINED_BYTES]}, call_id="huge")
    assert huge is None
    assert events[-1]["kind"] == "warning"
    assert events[-1]["payload"]["snapshot"]["complete"] is False
    assert events[-1]["payload"]["snapshot"]["data"] is None
    assert ctx.present({"type": "text", "title": "Invented", "source_refs": [{"evidence_id": events[-1]["payload"]["snapshot"]["evidence_id"], "path": "/devices"}], "metadata": {"body": {"evidence_id": events[-1]["payload"]["snapshot"]["evidence_id"], "path": "/devices"}}})["kind"] == "warning"
    valid = ctx.capture({"helper": "inventory"}, {"empty": [], "null": None}, call_id="small")
    for path in ("/missing", "/empty/0", "/__proto__", "$.empty", "/empty/~2"):
        assert ctx.present({"type": "text", "title": "No", "source_refs": [{"evidence_id": valid, "path": path}], "metadata": {"body": {"evidence_id": valid, "path": path}}})["kind"] == "warning"
    assert ctx.present({"type": "text", "title": "Empty", "source_refs": [{"evidence_id": valid, "path": "/empty"}], "metadata": {"body": {"evidence_id": valid, "path": "/empty"}}})["type"] == "text"
    foreign = {"evidence_id": FIXTURE["snapshots"][0]["evidence_id"], "path": "/devices"}
    assert ctx.present({"type": "text", "title": "Other workspace", "source_refs": [foreign], "metadata": {"body": foreign}})["kind"] == "warning"
    assert ctx.derive([], 4, "sum") is None
    assert ctx.derive([{"evidence_id": valid, "path": "/empty"}], 4, "") is None
    derived = ctx.derive([{"evidence_id": valid, "path": "/empty"}], 0, "count observed entries")
    assert ctx.snapshots[derived]["origin"] == "derived"
    assert ctx.snapshots[derived]["parent_refs"] == [{"evidence_id": valid, "path": "/empty"}]
    assert ctx.snapshots[derived]["calculation"] == "count observed entries"


def test_model_cells_and_executable_metadata_are_rejected():
    ctx, events = context()
    evidence_id = ctx.capture({"helper": "inventory"}, {"value": 0}, call_id="a")
    ref = {"evidence_id": evidence_id, "path": "/value"}
    for metadata in ({"body": ref, "value": 999}, {"body": 999}, {"body": ref, "onClick": "alert(1)"}):
        assert ctx.present({"type": "text", "title": "Invalid", "source_refs": [ref], "metadata": metadata})["kind"] == "warning"
    spec = {"type": "text", "title": "known-secret-987", "source_refs": [ref], "metadata": {"body": ref}}
    card = ctx.present(spec)
    assert card["title"] == "[REDACTED]"
    spec["metadata"]["body"]["path"] = "/missing"
    card["metadata"]["body"]["path"] = "/missing"
    assert events[-1]["payload"]["card"]["metadata"]["body"] == {"evidence_id": evidence_id, "path": "/value"}


def test_every_retained_field_is_redacted_and_warning_origin_is_normalized():
    ctx, events = context()
    evidence_id = ctx.capture(
        {"helper": "inventory", "arguments": {"refresh_token": "argument-leak"}},
        {"refresh_token": "refresh-leak", "id_token": "id-leak", "known-secret-987": "safe",
         "nested": [{"client_secret": "client-leak", "note": "known-secret-987"}]},
        call_id="safe-call-id")
    captured = ctx.snapshots[evidence_id]
    serialized = json.dumps(captured)
    for secret in ("known-secret-987", "refresh-leak", "id-leak", "client-leak", "argument-leak"):
        assert secret not in serialized
    assert captured["data"]["refresh_token"] == "[REDACTED]"
    assert captured["data"]["[REDACTED]"] == "safe"
    assert captured["call_id"] == "safe-call-id"

    assert ctx.capture({"helper": "inventory"}, 0, call_id="known-secret-987",
                       origin="derived", parent_refs=[{"evidence_id": evidence_id, "path": "",
                                                       "note": "known-secret-987"}], calculation="known-secret-987") is None
    assert "known-secret-987" not in json.dumps(events[-1])
    assert ctx.capture({"helper": "inventory"}, 0, call_id="bad-origin", origin="wrong") is None
    assert events[-1]["payload"]["snapshot"]["origin"] == "execution_output"


def test_topology_requires_observed_matching_relationship():
    ctx, _ = context()
    evidence_id = ctx.capture({"helper": "inventory"},
                              {"devices": [{"id": "a"}, {"id": "b"}], "links": [{"from": "a", "to": "b"}, {"from": "b", "to": "a"}]},
                              call_id="observed-links")
    a = {"evidence_id": evidence_id, "path": "/devices/0/id"}
    b = {"evidence_id": evidence_id, "path": "/devices/1/id"}
    spec = {"type": "topology", "title": "Observed", "source_refs": [a, b],
            "metadata": {"nodes": [{"id": a}, {"id": b}], "links": [{"from": a, "to": b}]}}
    assert ctx.present(spec)["kind"] == "warning"
    spec["metadata"]["links"][0]["relationship"] = {"evidence_id": evidence_id, "path": "/devices/0"}
    assert ctx.present(spec)["kind"] == "warning"
    spec["metadata"]["links"][0]["relationship"]["path"] = "/links/1"
    assert ctx.present(spec)["kind"] == "warning"
    spec["metadata"]["links"][0]["relationship"]["path"] = "/links/0"
    assert ctx.present(spec)["type"] == "topology"
    numeric = ctx.capture({"helper": "inventory"}, {"nodes": [1, 2], "links": [{"from": True, "to": 2}]},
                          call_id="numeric-link")
    one = {"evidence_id": numeric, "path": "/nodes/0"}
    two = {"evidence_id": numeric, "path": "/nodes/1"}
    relation = {"evidence_id": numeric, "path": "/links/0"}
    assert ctx.present({"type": "topology", "title": "Boolean is not an observed numeric ID",
                        "source_refs": [relation], "metadata": {"nodes": [{"id": one}, {"id": two}],
                        "links": [{"from": one, "to": two, "relationship": relation}]}})["kind"] == "warning"


def test_topology_requires_unique_typed_nodes_and_declared_endpoints():
    for origin in ("observed", "agent_authored"):
        for nodes, links, accepted in (
            (["a", "a"], [], False),
            ([1, 1.0], [], False),
            (["a"], [{"from": "a", "to": "missing"}], False),
            (["1", 1], [{"from": "1", "to": 1}], True),
        ):
            ctx, _ = context()
            evidence_id = ctx.capture({"helper": "synthetic"}, {"nodes": nodes, "links": links},
                                      call_id="typed-graph", origin=origin)
            def ref(path):
                return {"evidence_id": evidence_id, "path": path}
            metadata = {"nodes": [{"id": ref(f"/nodes/{i}")} for i in range(len(nodes))],
                        "links": [{"from": ref(f"/links/{i}/from"), "to": ref(f"/links/{i}/to"),
                                   "relationship": ref(f"/links/{i}")} for i in range(len(links))]}
            result = ctx.present({"type": "topology", "title": "Typed graph",
                                  "source_refs": [ref("")], "metadata": metadata})
            assert result.get("type") == "topology" if accepted else result["kind"] == "warning"


def test_sensitive_call_ids_never_collapse_distinct_helper_calls():
    events = []
    ctx = CanvasContext(FIXTURE["request"], events.append, ("secret-one", "secret-two"))
    for call_id in ("call-secret-one", "call-secret-two"):
        assert ctx.capture({"helper": "inventory"}, {"ok": True}, call_id=call_id) is None
        assert events[-1]["kind"] == "warning"
        assert events[-1]["payload"]["snapshot"]["complete"] is False
        assert "call ID" in events[-1]["payload"]["limitation"]
        assert "secret-one" not in json.dumps(events[-1])
        assert "secret-two" not in json.dumps(events[-1])
    assert ctx.snapshots == {}
    assert ctx.capture({"helper": "inventory"}, {"ok": True}, call_id="safe-id") is not None
    assert ctx.snapshots[next(iter(ctx.snapshots))]["call_id"] == "safe-id"
    assert ctx.capture({"helper": "inventory"}, {"ok": True}, call_id="") is None
    assert ctx.capture({"helper": ""}, {"ok": True}, call_id="new-id") is None
    assert ctx.capture({"helper": "inventory", "resource": {}}, {"ok": True}, call_id="new-id") is None


def test_derived_lineage_survives_cache_eviction_and_is_emitted_transitively():
    ctx, events = context()
    parent = ctx.capture({"helper": "inventory"}, {"value": 0}, call_id="observed")
    parent_ref = {"evidence_id": parent, "path": "/value"}
    child = ctx.derive([parent_ref], 0, "count observed values")
    child_ref = {"evidence_id": child, "path": ""}
    grandchild = ctx.derive([child_ref], 0, "copy verified count")
    parent_ref["path"] = "/missing"
    ctx.snapshots[parent]["data"]["value"] = 999
    assert ctx.snapshots[child]["parent_refs"][0]["path"] == "/value"
    assert ctx.snapshots[parent]["data"]["value"] == 0
    card = ctx.present({"type": "text", "title": "Derived", "source_refs": [{"evidence_id": grandchild, "path": ""}],
                        "metadata": {"body": {"evidence_id": grandchild, "path": ""}}})
    assert card["type"] == "text"
    assert {snapshot["evidence_id"] for snapshot in events[-1]["payload"]["snapshots"]} == {parent, child, grandchild}
    for index in range(3):
        ctx.capture({"helper": "large"}, {"blob": "x" * 900_000}, call_id=f"evict-{index}")
    assert {parent, child, grandchild}.issubset(ctx.snapshots)


def test_snapshot_envelope_and_temporary_cache_use_same_byte_bound():
    ctx, events = context()
    near_limit = ctx.capture({"helper": "inventory"}, "x" * (DEFAULT_MAX_RETAINED_BYTES - 200), call_id="near-limit")
    assert near_limit is None
    assert events[-1]["payload"]["snapshot"]["complete"] is False
    for index in range(500):
        ctx.capture({"helper": "tiny"}, {"index": index}, call_id=f"tiny-{index}")
    assert sum(len(json.dumps(snapshot, ensure_ascii=False).encode("utf-8")) for snapshot in ctx.snapshots.values()) <= DEFAULT_MAX_RETAINED_BYTES
    assert ctx.capture({"helper": "h" * DEFAULT_MAX_RETAINED_BYTES}, 0, call_id="oversized-helper") is None
    assert len(json.dumps(events[-1]).encode("utf-8")) <= DEFAULT_MAX_RETAINED_BYTES


def test_unpresented_derived_lineage_does_not_pin_orphans_forever():
    ctx, _ = context()
    parent = ctx.capture({"helper": "inventory"}, {"value": 0}, call_id="a")
    child = ctx.derive([{"evidence_id": parent, "path": "/value"}], 0, "copy counter")
    for index in range(4):
        ctx.capture({"helper": "large"}, {"blob": "x" * 900_000}, call_id=f"large-{index}")
    assert child not in ctx.snapshots
    assert parent not in ctx.snapshots


def test_failed_card_delivery_reports_canvas_limitation_not_success():
    events = []

    def reject(event):
        if event["kind"] == "card":
            raise RuntimeError("transport offline")
        events.append(event)

    ctx = CanvasContext(FIXTURE["request"], reject, ())
    evidence_id = ctx.capture({"helper": "inventory"}, {"value": 0}, call_id="observed")
    ref = {"evidence_id": evidence_id, "path": "/value"}
    result = ctx.present({"type": "text", "title": "Undelivered", "source_refs": [ref], "metadata": {"body": ref}})
    assert result["kind"] == "warning"
    assert "delivery" in result["limitation"]
    ctx.finish_presentation()
    assert len(events) == 1 and events[0]["kind"] == "warning"
    assert "no validated cards" in events[0]["payload"]["limitation"]
