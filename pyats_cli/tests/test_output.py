"""Tests for output renderers."""

import json
import pytest
import yaml as pyyaml
from terminai_pyats.output import render_json, render_table, render_yaml


@pytest.fixture
def success_envelope():
    return {
        "ok": True,
        "data": {"name": "CORE1", "ip": "10.0.0.1"},
        "meta": {"verb": "list-devices"}
    }


@pytest.fixture
def error_envelope():
    return {
        "ok": False,
        "error": {
            "code": "network_error",
            "message": "Connection failed",
            "hint": "Check device IP"
        }
    }


def test_render_json_formats_envelope(success_envelope):
    output = render_json(success_envelope)
    parsed = json.loads(output)
    assert parsed["ok"] is True
    assert parsed["data"]["name"] == "CORE1"


def test_render_json_handles_error(error_envelope):
    output = render_json(error_envelope)
    parsed = json.loads(output)
    assert parsed["ok"] is False
    assert parsed["error"]["code"] == "network_error"


def test_render_yaml_formats_envelope(success_envelope):
    output = render_yaml(success_envelope)
    parsed = pyyaml.safe_load(output)
    assert parsed["ok"] is True
    assert parsed["data"]["name"] == "CORE1"


def test_render_yaml_handles_error(error_envelope):
    output = render_yaml(error_envelope)
    parsed = pyyaml.safe_load(output)
    assert parsed["ok"] is False
    assert parsed["error"]["hint"] == "Check device IP"


def test_render_table_renders_success(success_envelope):
    output = render_table(success_envelope)
    assert isinstance(output, str)
    assert len(output) > 0
    # Table output should contain data keys
    assert "name" in output or "CORE1" in output


def test_render_table_renders_error_in_red(error_envelope):
    output = render_table(error_envelope)
    assert isinstance(output, str)
    assert "Error" in output or "error" in output
    assert "Connection failed" in output


def test_render_table_handles_list_data():
    envelope = {
        "ok": True,
        "data": [
            {"device": "CORE1", "status": "up"},
            {"device": "CORE2", "status": "down"}
        ]
    }
    output = render_table(envelope)
    assert "CORE1" in output
    assert "CORE2" in output


def test_render_table_handles_empty_list():
    envelope = {"ok": True, "data": []}
    output = render_table(envelope)
    assert isinstance(output, str)
    # Should indicate no results
    assert len(output) > 0
