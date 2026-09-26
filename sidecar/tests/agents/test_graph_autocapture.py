"""Tests for the deterministic memory WRITE hook + read-before-answer recall.

Covers the universal (vendor-agnostic) wiring: install_autocapture wraps every
`*_api_call` global; capture() persists durable facts; recall_context_message
retrieves them for the entities a question names. Uses a temp sessions.db and
monkeypatches the flag ON.
"""
import pathlib
import sqlite3

import pytest

from ccie_sidecar.agents import graph_autocapture as ac
from ccie_sidecar.agents.graph_autocapture import (
    capture,
    install_autocapture,
    recall_context_message,
)

_MIGRATIONS = pathlib.Path(__file__).resolve().parents[3] / "src-tauri" / "migrations"


def _seed_db(path: str) -> None:
    conn = sqlite3.connect(path)
    conn.executescript((_MIGRATIONS / "V0071__entities_and_relations.sql").read_text())
    conn.executescript((_MIGRATIONS / "V0072__graph_memory.sql").read_text())
    conn.commit()
    conn.close()


@pytest.fixture()
def db(tmp_path, monkeypatch):
    path = tmp_path / "sessions.db"
    _seed_db(str(path))
    # graph_autocapture resolves the DB via graph_helper._db_path; point both.
    from ccie_sidecar.agents import graph_helper
    monkeypatch.setattr(graph_helper, "_db_path", lambda: path)
    monkeypatch.setattr(ac, "_enabled", lambda: True)
    return path


def _facts(path):
    conn = sqlite3.connect(str(path))
    try:
        return {(r[0], r[1]): r[2] for r in conn.execute(
            "SELECT entity, key, value FROM graph_facts WHERE valid_to IS NULL")}
    finally:
        conn.close()


# --- capture: persists durable ids/topology ---------------------------------

def test_capture_orgs(db):
    capture("meraki", "GET", "/organizations",
            {"status_code": 200, "data": [{"id": "155503", "name": "ExampleOrg"}]})
    assert _facts(db).get(("meraki:org:exampleorg", "org_id")) == "155503"


def test_capture_networks(db):
    capture("meraki", "GET", "/organizations/155503/networks",
            {"status_code": 200, "data": [{"id": "L_123", "name": "Example-Branch"}]})
    assert _facts(db).get(("meraki:network:example-branch", "network_id")) == "L_123"


def test_capture_topology_two_facts(db):
    topo = {
        "nodes": [
            {"type": "device", "device": {"name": "Core", "serial": "Q1", "model": "MS390"}},
            {"type": "device", "device": {"name": "Edge", "serial": "Q2", "model": "MS225"}},
        ],
        "links": [{"ends": [{"device": {"name": "Core"}}, {"device": {"name": "Edge"}}]}],
    }
    capture("meraki", "GET", "/networks/L_123/topology/linkLayer",
            {"status_code": 200, "data": topo})
    f = _facts(db)
    assert "Core" in f[("meraki:topology:l_123", "devices")]
    assert "Core <-> Edge" in f[("meraki:topology:l_123", "links")]
    # Topology stored as TWO facts, not one-per-device (avoids flooding recall).
    assert not any(k[0].startswith("meraki:device:") for k in f)


def test_capture_skips_non_get_and_errors(db):
    capture("meraki", "POST", "/organizations", {"status_code": 200, "data": [{"id": "1", "name": "x"}]})
    capture("meraki", "GET", "/organizations", {"status_code": 401, "data": None})
    assert _facts(db) == {}


def test_capture_noop_when_disabled(tmp_path, monkeypatch):
    path = tmp_path / "sessions.db"
    _seed_db(str(path))
    from ccie_sidecar.agents import graph_helper
    monkeypatch.setattr(graph_helper, "_db_path", lambda: path)
    monkeypatch.setattr(ac, "_enabled", lambda: False)
    capture("meraki", "GET", "/organizations",
            {"status_code": 200, "data": [{"id": "1", "name": "x"}]})
    assert _facts(path) == {}


# --- install_autocapture: universal wrapping of every *_api_call -------------

def test_install_wraps_all_vendor_api_calls(db):
    calls = {"meraki": [], "mist": []}

    def make(vendor):
        def fn(method, path, body=None, query_params=None):
            calls[vendor].append((method, path))
            return '{"status_code":200,"data":[]}'
        return fn

    g = {"meraki_api_call": make("meraki"), "mist_api_call": make("mist"), "other": 1}
    n = install_autocapture(g)
    assert n == 2  # both api_call globals wrapped, "other" untouched
    assert getattr(g["meraki_api_call"], "_ccie_autocapture", False)
    assert getattr(g["mist_api_call"], "_ccie_autocapture", False)
    # Wrapper is transparent: underlying fn still runs and result passes through.
    assert g["meraki_api_call"]("GET", "/organizations") == '{"status_code":200,"data":[]}'
    assert calls["meraki"] == [("GET", "/organizations")]


def test_install_idempotent(db):
    g = {"x_api_call": lambda *a, **k: "{}"}
    install_autocapture(g)
    first = g["x_api_call"]
    install_autocapture(g)  # second pass must not double-wrap
    assert g["x_api_call"] is first


def test_install_noop_when_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(ac, "_enabled", lambda: False)
    g = {"meraki_api_call": lambda *a, **k: "{}"}
    assert install_autocapture(g) == 0
    assert not getattr(g["meraki_api_call"], "_ccie_autocapture", False)


# --- recall_context_message: read-before-answer -----------------------------

def test_recall_names_matched_entity(db):
    capture("meraki", "GET", "/organizations/155503/networks",
            {"status_code": 200, "data": [{"id": "L_123", "name": "Example-Branch"}]})
    msg = recall_context_message("draw the topology for example-branch please")
    assert "ESTABLISHED CONTEXT" in msg
    assert "L_123" in msg


def test_recall_bridges_network_to_topology(db):
    capture("meraki", "GET", "/organizations/155503/networks",
            {"status_code": 200, "data": [{"id": "L_123", "name": "Example-Branch"}]})
    capture("meraki", "GET", "/networks/L_123/topology/linkLayer",
            {"status_code": 200, "data": {
                "nodes": [{"type": "device", "device": {"name": "Core", "serial": "Q1", "model": "MS390"}}],
                "links": [{"ends": [{"device": {"name": "Core"}}, {"device": {"name": "Edge"}}]}],
            }})
    # Asking by network NAME should surface the topology keyed by network_id.
    msg = recall_context_message("draw example-branch topology")
    assert "Core <-> Edge" in msg


def test_recall_empty_when_nothing_matches(db):
    capture("meraki", "GET", "/organizations/155503/networks",
            {"status_code": 200, "data": [{"id": "L_123", "name": "Example-Branch"}]})
    assert recall_context_message("what is the weather today") == ""


def test_recall_noop_when_disabled(tmp_path, monkeypatch):
    monkeypatch.setattr(ac, "_enabled", lambda: False)
    assert recall_context_message("anything about example-branch") == ""
