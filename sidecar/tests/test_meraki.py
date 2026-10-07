"""Focused tests for the shared Meraki REST helper."""
from __future__ import annotations

from ccie_sidecar.meraki import MerakiClient


def test_meraki_array_query_params_use_dashboard_bracket_keys():
    params = MerakiClient._normalize_query_params(
        {
            "networkIds": ["L_one", "L_two"],
            "statuses[]": ["offline"],
            "active": True,
            "perPage": 100,
        }
    )

    assert params == [
        ("networkIds[]", "L_one"),
        ("networkIds[]", "L_two"),
        ("statuses[]", "offline"),
        ("active", True),
        ("perPage", 100),
    ]


def test_meraki_empty_array_query_param_is_omitted():
    assert MerakiClient._normalize_query_params(
        {"networkIds": [], "active": True}
    ) == [("active", True)]


def test_meraki_without_credentials_keeps_actionable_error_and_does_not_connect(monkeypatch):
    client = MerakiClient(None)

    def forbidden():
        raise AssertionError("Missing credentials must fail before opening a session")

    monkeypatch.setattr(client, "_ensure_session", forbidden)
    for method in ("GET", "DELETE"):
        result = client.call(method, "/organizations")
        assert result["status_code"] == 0
        assert result["data"] is None
        assert result["error"] == "Meraki is not configured. Set the API key in Settings -> Meraki."
        assert result["blast_radius"] == ("low" if method == "GET" else "destructive")
