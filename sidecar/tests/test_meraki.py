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
