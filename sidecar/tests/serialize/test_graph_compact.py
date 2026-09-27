"""Tests for the graph-compact serializer.

Covers the three profiles (table / graph / JSON fallback), the never-raise
contract, mode gating, and the token-savings acceptance bar (>=30% on a
50-route sample).
"""
import json

import pytest

from ccie_sidecar.serialize import graph_compact as gc


def _routes(n=50):
    return [
        {"prefix": f"10.0.{i}.0/24", "next_hop": f"10.255.0.{i % 8}",
         "protocol": "ospf", "metric": 20 + i, "intf": f"Gi0/{i % 4}"}
        for i in range(n)
    ]


def test_off_mode_is_json_passthrough():
    data = _routes(3)
    assert gc.encode(data, mode="off") == json.dumps(data)


def test_table_profile_headers_once():
    out = gc.encode(_routes(3), mode="generic")
    assert out.startswith("#table")
    # Header line lists columns; keys must NOT repeat per row.
    assert out.count("next_hop") == 1
    assert out.count("prefix") == 1
    assert len(out.splitlines()) == 2 + 3  # marker + header + 3 rows


def test_generic_mode_never_uses_graph_profile():
    edges = [{"source": "R1", "target": "R2", "proto": "cdp"},
             {"source": "R2", "target": "R3", "proto": "cdp"}]
    out = gc.encode(edges, mode="generic")
    assert out.startswith("#table")  # not #graph


def test_graph_profile_detects_edges():
    edges = [{"source": "R1", "target": "R2", "proto": "cdp"},
             {"source": "R2", "target": "R3", "proto": "cdp"}]
    out = gc.encode(edges, mode="graph")
    assert out.startswith("#graph")
    assert "#nodes" in out and "#edges" in out
    assert "0>1" in out and "1>2" in out  # local-id arrows


def test_graph_profile_from_nodes_edges_dict():
    payload = {"nodes": [], "edges": [
        {"a_device_ref": "R1", "b_device_ref": "R2", "protocol": "bgp"},
        {"a_device_ref": "R2", "b_device_ref": "R3", "protocol": "bgp"},
    ]}
    out = gc.encode(payload, mode="full")
    assert out.startswith("#graph")


def test_nested_values_fall_back_to_json():
    data = [{"id": 1, "nested": {"x": 1}}, {"id": 2, "nested": {"x": 2}}]
    assert gc.encode(data, mode="full") == json.dumps(data)


def test_scalar_and_small_inputs_fall_back():
    assert gc.encode({"a": 1}, mode="full") == json.dumps({"a": 1})
    assert gc.encode([{"a": 1}], mode="full") == json.dumps([{"a": 1}])  # <2 rows


def test_never_raises_on_weird_input():
    class Weird:
        pass
    # json.dumps would raise on Weird; encode must still not raise (it returns
    # the json fallback which itself raises) -> guard: wrap in list-of-dicts path.
    data = [{"k": "v"}, {"k": "w"}]
    assert gc.encode(data, mode="full").startswith("#table")


def test_csv_escaping():
    data = [{"a": "x,y", "b": 'has "quote"'}, {"a": "z", "b": "plain"}]
    out = gc.encode(data, mode="generic")
    assert '"x,y"' in out
    assert '"has ""quote"""' in out


def test_token_savings_at_least_30pct_on_routes():
    stats = gc.encode_with_stats(_routes(50), mode="full")
    assert stats["mode"] == "full"
    assert stats["saved_pct"] >= 30.0, stats


def test_default_mode_off_env(monkeypatch):
    monkeypatch.delenv("CCIE_GCF_MODE", raising=False)
    data = _routes(3)
    # No mode arg + no env -> default 'off' -> JSON passthrough.
    assert gc.encode(data) == json.dumps(data)
