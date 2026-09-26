"""Tests for verb catalog."""

import json
import pytest
from terminai_pyats.catalog import VerbSpec, VERBS, get_verb_spec


def test_verb_spec_dataclass_structure():
    spec = VerbSpec(
        name="test-verb",
        description="Test verb",
        blast_radius="low",
        args={"device": {"type": "string"}},
        required=["device"]
    )
    assert spec.name == "test-verb"
    assert spec.blast_radius == "low"
    assert "device" in spec.args
    assert "device" in spec.required


def test_verbs_list_has_fifteen_verbs():
    """Phase 1+2 includes 15 verbs total."""
    assert len(VERBS) == 15
    verb_names = [v.name for v in VERBS]

    # Phase 1 read verbs (low)
    assert "list-devices" in verb_names
    assert "search-devices" in verb_names
    assert "run-show-command" in verb_names
    assert "learn" in verb_names
    assert "device-health" in verb_names
    assert "get-neighbors" in verb_names

    # Phase 2 additions
    assert "run-show-command-multi" in verb_names
    assert "find-interface-by-ip" in verb_names
    assert "ping" in verb_names
    assert "run-linux-command" in verb_names
    assert "configure" in verb_names
    assert "configure-multi" in verb_names
    assert "configure-with-diff" in verb_names
    assert "rollback-config" in verb_names
    assert "run-pyats-code" in verb_names


def test_blast_radius_tiers():
    """Verify correct blast radius assignments."""
    by_tier = {}
    for verb in VERBS:
        tier = verb.blast_radius
        by_tier.setdefault(tier, []).append(verb.name)

    assert len(by_tier["low"]) == 9  # 9 read operations
    assert len(by_tier["medium"]) == 1  # run-linux-command
    assert len(by_tier["high"]) == 4  # configure*3 + rollback
    assert len(by_tier["computed"]) == 1  # run-pyats-code


def test_list_devices_spec():
    spec = get_verb_spec("list-devices")
    assert spec is not None
    assert spec.name == "list-devices"
    assert spec.blast_radius == "low"
    assert spec.required == []  # No required args


def test_search_devices_spec():
    spec = get_verb_spec("search-devices")
    assert spec is not None
    assert spec.name == "search-devices"
    assert "query" in spec.required
    assert spec.args["query"]["type"] == "string"


def test_run_show_command_spec():
    spec = get_verb_spec("run-show-command")
    assert spec is not None
    assert "device" in spec.required
    assert "command" in spec.required
    assert spec.args["device"]["type"] == "string"
    assert spec.args["command"]["type"] == "string"


def test_learn_spec():
    spec = get_verb_spec("learn")
    assert spec is not None
    assert "device" in spec.required
    assert "feature" in spec.required
    assert spec.args["feature"]["type"] == "string"


def test_device_health_spec():
    spec = get_verb_spec("device-health")
    assert spec is not None
    assert "device" in spec.required


def test_get_neighbors_spec():
    spec = get_verb_spec("get-neighbors")
    assert spec is not None
    assert "device" in spec.required


def test_get_verb_spec_returns_none_for_unknown():
    spec = get_verb_spec("nonexistent-verb")
    assert spec is None


def test_verb_spec_to_dict():
    spec = VerbSpec(
        name="test",
        description="Test",
        blast_radius="low",
        args={"x": {"type": "string"}},
        required=["x"]
    )
    d = spec.to_dict()
    assert d["name"] == "test"
    assert d["blast_radius"] == "low"
    assert d["args"]["x"]["type"] == "string"
    assert d["required"] == ["x"]


def test_verbs_can_serialize_to_json():
    """Verify catalog can be exported to tools.json."""
    catalog = [v.to_dict() for v in VERBS]
    json_str = json.dumps(catalog, indent=2)
    parsed = json.loads(json_str)
    assert len(parsed) == 15
    assert any(v["name"] == "list-devices" for v in parsed)
    assert any(v["name"] == "configure" for v in parsed)
