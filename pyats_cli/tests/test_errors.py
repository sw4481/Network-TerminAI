"""Tests for error envelope structure."""

import pytest
from terminai_pyats.errors import PyatsError, to_envelope


def test_pyats_error_has_message_and_hint():
    exc = PyatsError("Connection failed", hint="Check device IP")
    assert exc.message == "Connection failed"
    assert exc.hint == "Check device IP"
    assert str(exc) == "Connection failed"


def test_pyats_error_defaults_to_empty_hint():
    exc = PyatsError("Something went wrong")
    assert exc.message == "Something went wrong"
    assert exc.hint == ""


def test_to_envelope_wraps_pyats_error():
    exc = PyatsError("Device not found", hint="Verify testbed.yaml")
    envelope = to_envelope(exc)

    assert envelope["ok"] is False
    assert envelope["error"]["code"] == "pyats_error"
    assert envelope["error"]["message"] == "Device not found"
    assert envelope["error"]["hint"] == "Verify testbed.yaml"


def test_to_envelope_wraps_generic_exception():
    exc = ValueError("Invalid parameter")
    envelope = to_envelope(exc)

    assert envelope["ok"] is False
    assert envelope["error"]["code"] == "validation_error"
    assert envelope["error"]["message"] == "Invalid parameter"
    assert "hint" in envelope["error"]


def test_to_envelope_wraps_connection_error():
    exc = ConnectionError("Network unreachable")
    envelope = to_envelope(exc)

    assert envelope["ok"] is False
    assert envelope["error"]["code"] == "network_error"
    assert "hint" in envelope["error"]
