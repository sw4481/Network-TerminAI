"""Unit tests for output renderers."""

import json

import pytest
import yaml

from terminai_meraki.output import render_json, render_table, render_yaml

# Sample test data
SAMPLE_ORG = {"id": "O_123", "name": "Test Org", "url": "https://dashboard.meraki.com/o/123"}
SAMPLE_ERROR = {"code": "auth", "message": "Invalid API key", "hint": "Rotate key"}

SAMPLE_NETWORK = {
    "id": "N_456",
    "name": "HQ-Office",
    "organizationId": "O_123",
    "productTypes": ["wireless", "appliance"],
}

SAMPLE_CLIENT = {
    "id": "k123456",
    "mac": "00:11:22:33:44:55",
    "description": "Laptop",
    "ip": "device.example.test",
    "vlan": 10,
}


class TestRenderJson:
    """Tests for render_json()."""

    def test_success_envelope_single_object(self):
        """Test rendering success envelope with single object."""
        envelope = {
            "ok": True,
            "data": SAMPLE_ORG,
            "meta": {"endpoint": {"method": "GET", "path": "/organizations"}, "blast_radius": "low"},
        }

        result = render_json(envelope)

        # Should be valid JSON
        parsed = json.loads(result)
        assert parsed == envelope
        assert '"ok": true' in result  # Check formatting
        assert parsed["data"]["id"] == "O_123"

    def test_success_envelope_list(self):
        """Test rendering success envelope with list response."""
        envelope = {
            "ok": True,
            "data": [SAMPLE_ORG, {"id": "O_456", "name": "Other Org", "url": "https://..."}],
            "meta": {"blast_radius": "low"},
        }

        result = render_json(envelope)

        parsed = json.loads(result)
        assert parsed == envelope
        assert len(parsed["data"]) == 2

    def test_error_envelope(self):
        """Test rendering error envelope."""
        envelope = {"ok": False, "error": SAMPLE_ERROR}

        result = render_json(envelope)

        parsed = json.loads(result)
        assert parsed == envelope
        assert parsed["error"]["code"] == "auth"

    def test_empty_list(self):
        """Test rendering empty list."""
        envelope = {"ok": True, "data": []}

        result = render_json(envelope)

        parsed = json.loads(result)
        assert parsed["data"] == []

    def test_null_data(self):
        """Test rendering null data."""
        envelope = {"ok": True, "data": None}

        result = render_json(envelope)

        parsed = json.loads(result)
        assert parsed["data"] is None

    def test_indent_formatting(self):
        """Test that JSON uses 2-space indentation."""
        envelope = {"ok": True, "data": {"nested": {"key": "value"}}}

        result = render_json(envelope)

        # Check for 2-space indentation
        assert '  "ok"' in result or '  "data"' in result


class TestRenderTable:
    """Tests for render_table()."""

    def test_success_single_object(self):
        """Test table rendering of single object."""
        envelope = {"ok": True, "data": SAMPLE_ORG}

        result = render_table(envelope)

        # Should contain key-value pairs
        assert "id" in result
        assert "O_123" in result
        assert "name" in result
        assert "Test Org" in result
        assert "url" in result

    def test_success_list_of_objects(self):
        """Test table rendering of list of objects."""
        envelope = {
            "ok": True,
            "data": [
                SAMPLE_CLIENT,
                {"id": "k654321", "mac": "AA:BB:CC:DD:EE:FF", "description": "Phone", "ip": "device2.example.test", "vlan": 10},
            ],
        }

        result = render_table(envelope)

        # Should contain column headers from first item
        assert "id" in result
        assert "mac" in result
        assert "description" in result

        # Should contain data from both rows
        assert "k123456" in result
        assert "k654321" in result
        assert "Laptop" in result
        assert "Phone" in result

    def test_empty_list(self):
        """Test table rendering of empty list."""
        envelope = {"ok": True, "data": []}

        result = render_table(envelope)

        # Should indicate no results
        assert "No results" in result or "Results" in result

    def test_error_envelope(self):
        """Test table rendering of error."""
        envelope = {"ok": False, "error": SAMPLE_ERROR}

        result = render_table(envelope)

        # Should contain error details
        assert "auth" in result
        assert "Invalid API key" in result
        assert "Rotate key" in result
        # Rich adds ANSI codes, but the text should be there

    def test_null_data(self):
        """Test table rendering of null data."""
        envelope = {"ok": True, "data": None}

        result = render_table(envelope)

        # Should handle gracefully
        assert "Success" in result or "OK" in result

    def test_nested_dict_in_list(self):
        """Test table rendering when list items contain nested dicts."""
        envelope = {
            "ok": True,
            "data": [
                {"id": "N_123", "name": "Network 1", "tags": {"env": "prod"}},
                {"id": "N_456", "name": "Network 2", "tags": {"env": "dev"}},
            ],
        }

        result = render_table(envelope)

        # Should contain the IDs and names
        assert "N_123" in result
        assert "Network 1" in result
        # Nested dict should be serialized as JSON
        assert "tags" in result

    def test_list_of_scalars(self):
        """Test table rendering of list of non-dict items."""
        envelope = {"ok": True, "data": ["value1", "value2", "value3"]}

        result = render_table(envelope)

        # Should contain the values
        assert "value1" in result
        assert "value2" in result
        assert "value3" in result

    def test_scalar_data(self):
        """Test table rendering of scalar value."""
        envelope = {"ok": True, "data": "single-value"}

        result = render_table(envelope)

        assert "single-value" in result


class TestRenderYaml:
    """Tests for render_yaml()."""

    def test_success_envelope_single_object(self):
        """Test YAML rendering of success envelope."""
        envelope = {
            "ok": True,
            "data": SAMPLE_ORG,
            "meta": {"blast_radius": "low"},
        }

        result = render_yaml(envelope)

        # Should be valid YAML
        parsed = yaml.safe_load(result)
        assert parsed == envelope
        assert parsed["data"]["id"] == "O_123"

    def test_success_envelope_list(self):
        """Test YAML rendering of list response."""
        envelope = {
            "ok": True,
            "data": [SAMPLE_NETWORK, {"id": "N_789", "name": "Branch"}],
        }

        result = render_yaml(envelope)

        parsed = yaml.safe_load(result)
        assert parsed == envelope
        assert len(parsed["data"]) == 2

    def test_error_envelope(self):
        """Test YAML rendering of error envelope."""
        envelope = {"ok": False, "error": SAMPLE_ERROR}

        result = render_yaml(envelope)

        parsed = yaml.safe_load(result)
        assert parsed == envelope
        assert parsed["error"]["code"] == "auth"
        assert parsed["error"]["hint"] == "Rotate key"

    def test_empty_list(self):
        """Test YAML rendering of empty list."""
        envelope = {"ok": True, "data": []}

        result = render_yaml(envelope)

        parsed = yaml.safe_load(result)
        assert parsed["data"] == []

    def test_null_data(self):
        """Test YAML rendering of null data."""
        envelope = {"ok": True, "data": None}

        result = render_yaml(envelope)

        parsed = yaml.safe_load(result)
        assert parsed["data"] is None

    def test_nested_structures(self):
        """Test YAML rendering of deeply nested structures."""
        envelope = {
            "ok": True,
            "data": {
                "org": SAMPLE_ORG,
                "networks": [SAMPLE_NETWORK],
                "clients": [SAMPLE_CLIENT],
            },
        }

        result = render_yaml(envelope)

        parsed = yaml.safe_load(result)
        assert parsed == envelope
        assert parsed["data"]["org"]["id"] == "O_123"
        assert len(parsed["data"]["networks"]) == 1
        assert parsed["data"]["networks"][0]["name"] == "HQ-Office"

    def test_unicode_handling(self):
        """Test YAML rendering with unicode characters."""
        envelope = {
            "ok": True,
            "data": {"name": "Café ☕", "location": "São Paulo"},
        }

        result = render_yaml(envelope)

        parsed = yaml.safe_load(result)
        assert parsed["data"]["name"] == "Café ☕"
        assert parsed["data"]["location"] == "São Paulo"


class TestRendererEdgeCases:
    """Test edge cases across all renderers."""

    def test_all_renderers_handle_minimal_envelope(self):
        """Test all renderers can handle minimal envelope."""
        envelope = {"ok": True}

        # Should not raise
        json_result = render_json(envelope)
        table_result = render_table(envelope)
        yaml_result = render_yaml(envelope)

        assert json_result
        assert table_result
        assert yaml_result

    def test_all_renderers_handle_complex_meta(self):
        """Test all renderers handle envelope with complex meta."""
        envelope = {
            "ok": True,
            "data": SAMPLE_ORG,
            "meta": {
                "endpoint": {"method": "POST", "path": "/networks/{id}/claim"},
                "blast_radius": "high",
                "timestamp": "2026-05-24T12:00:00Z",
            },
        }

        # Should not raise
        json_result = render_json(envelope)
        table_result = render_table(envelope)
        yaml_result = render_yaml(envelope)

        assert json_result
        assert table_result
        assert yaml_result

    def test_error_with_missing_fields(self):
        """Test error envelope with missing optional fields."""
        envelope = {"ok": False, "error": {"message": "Something went wrong"}}

        # Should handle gracefully
        json_result = render_json(envelope)
        table_result = render_table(envelope)
        yaml_result = render_yaml(envelope)

        assert "Something went wrong" in json_result
        assert "Something went wrong" in table_result
        assert "Something went wrong" in yaml_result

    def test_very_long_strings(self):
        """Test renderers handle very long strings."""
        long_string = "x" * 1000
        envelope = {"ok": True, "data": {"field": long_string}}

        # Should not raise
        json_result = render_json(envelope)
        table_result = render_table(envelope)
        yaml_result = render_yaml(envelope)

        assert long_string in json_result
        assert long_string in yaml_result
        # Table might truncate, but should not crash
        assert table_result
