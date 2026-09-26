"""Tests for the context-graph sandbox helper.

Builds a temp sessions.db from the real migration SQL (V0040 topology + V0071
entities) plus minimal stand-ins for the device/config/drift/rag tables, then
exercises every GraphHelper query. Also covers the fail-soft path (missing DB
and missing tables must never raise).
"""
import os
import sqlite3
import pathlib

import pytest

from ccie_sidecar.agents import graph_helper
from ccie_sidecar.agents.graph_helper import GraphHelper, install_graph

GLOBAL_GRAPH = "00000000-0000-0000-0000-0000000000g1"

# Repo migrations dir, resolved relative to this test file.
_MIGRATIONS = (
    pathlib.Path(__file__).resolve().parents[3] / "src-tauri" / "migrations"
)


def _seed_db(path: str) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        (_MIGRATIONS / "V0040__topology_graphs_and_neighbor_cache.sql").read_text()
    )
    conn.executescript(
        (_MIGRATIONS / "V0071__entities_and_relations.sql").read_text()
    )
    conn.executescript(
        (_MIGRATIONS / "V0072__graph_memory.sql").read_text()
    )
    conn.executescript(
        """
        CREATE TABLE ssh_connections (id TEXT PRIMARY KEY, name TEXT, host TEXT, user TEXT, port INTEGER);
        CREATE TABLE netconf_devices (id INTEGER PRIMARY KEY, name TEXT, host TEXT, platform TEXT);
        CREATE TABLE config_snapshots (id TEXT PRIMARY KEY, device_id TEXT, device_kind TEXT, vendor TEXT, platform TEXT, normalized_config TEXT, label TEXT, source TEXT, captured_at INTEGER);
        CREATE TABLE drift_reports (id TEXT PRIMARY KEY, template_id TEXT, device_id TEXT, device_kind TEXT, status TEXT, severity TEXT, diff_patch TEXT, captured_at INTEGER);
        CREATE TABLE rag_documents (id INTEGER PRIMARY KEY, title TEXT, source_path TEXT, kind TEXT, bytes INTEGER, uploaded_at INTEGER);
        CREATE TABLE rag_chunks (id INTEGER PRIMARY KEY, document_id INTEGER, chunk_idx INTEGER, text TEXT);
        """
    )
    conn.execute("INSERT INTO ssh_connections VALUES ('1','core-R1','10.0.0.1','admin',22)")
    conn.execute(
        "INSERT INTO topology_nodes VALUES (?, 'R1','discovered','R1','cisco','iosxe','10.0.0.1')",
        (GLOBAL_GRAPH,),
    )
    conn.execute(
        "INSERT INTO topology_nodes VALUES (?, 'R2','discovered','R2','cisco','iosxe','10.0.0.2')",
        (GLOBAL_GRAPH,),
    )
    conn.execute(
        "INSERT INTO topology_edges VALUES (?, 'R1','Gi0/0','R2','Gi0/1','cdp',100)",
        (GLOBAL_GRAPH,),
    )
    conn.execute(
        "INSERT INTO config_snapshots VALUES ('s1','R1','ssh','cisco','iosxe','hostname R1','base','manual',200)"
    )
    conn.execute(
        "INSERT INTO drift_reports VALUES ('dr1','t1','R1','ssh','drift','additive','+x',300)"
    )
    conn.execute("INSERT INTO rag_documents VALUES (1,'OSPF Design','/docs/ospf.pdf','pdf',100,1)")
    conn.execute(
        "INSERT INTO rag_chunks VALUES (1,1,0,'Configure OSPF stub area 10 for the branch.')"
    )
    conn.commit()
    conn.close()


@pytest.fixture()
def helper(tmp_path, monkeypatch):
    db = tmp_path / "sessions.db"
    _seed_db(str(db))
    monkeypatch.setattr(graph_helper, "_db_path", lambda: db)
    return GraphHelper()


def test_find_entity_resolves_topology_and_ssh(helper):
    res = helper.find_entity("R1")
    assert res["ok"]
    refs = {m["entity_id"] for m in res["matches"]}
    assert "discovered:R1" in refs
    assert "ssh:10.0.0.1" in refs  # matched via mgmt_ip LIKE


def test_find_entity_empty_query(helper):
    res = helper.find_entity("")
    assert res["ok"] is False


def test_neighbors_direct(helper):
    res = helper.neighbors("R1")
    assert res["ok"]
    assert len(res["neighbors"]) == 1
    n = res["neighbors"][0]
    assert n["neighbor"] == "R2"
    assert n["local_port"] == "Gi0/0"
    assert n["neighbor_port"] == "Gi0/1"
    assert n["protocol"] == "cdp"


def test_neighbors_protocol_filter(helper):
    assert helper.neighbors("R1", protocol="bgp")["neighbors"] == []
    assert len(helper.neighbors("R1", protocol="cdp")["neighbors"]) == 1


def test_entity_context(helper):
    ctx = helper.entity_context("R1")
    assert ctx["ok"]
    assert ctx["config"]["id"] == "s1"
    assert ctx["drift"][0]["status"] == "drift"


def test_search_keyword(helper):
    res = helper.search("OSPF")
    assert res["ok"]
    assert res["results"][0]["doc"] == "OSPF Design"
    assert "stub area 10" in res["results"][0]["snippet"]


def test_find_entity_materializes_overlay(helper, tmp_path):
    helper.find_entity("R1")
    conn = sqlite3.connect(str(tmp_path / "sessions.db"))
    rows = dict(conn.execute("SELECT entity_id, label FROM entities").fetchall())
    conn.close()
    assert rows["discovered:R1"] == "R1"


def test_missing_db_fails_soft(tmp_path, monkeypatch):
    monkeypatch.setattr(graph_helper, "_db_path", lambda: tmp_path / "nope.db")
    h = GraphHelper()
    assert h.find_entity("R1") == {"ok": True, "matches": [], "error": None}
    assert h.neighbors("R1")["neighbors"] == []
    assert h.search("x")["results"] == []


# -- General input-robustness & identity-bridging invariants ---------------
# These are device-agnostic: they assert the helper handles ANY caller phrasing
# (dict vs string) and ANY identifier (IP vs hostname), not a specific device.


def test_neighbors_accepts_dict_input(helper):
    """Agents often pass find_entity()'s result (a dict) straight to
    neighbors(); it must be coerced, not crash on .strip()."""
    envelope = helper.find_entity("R1")                     # {ok, matches:[...]}
    assert helper.neighbors(envelope)["ok"]                 # whole envelope
    assert helper.neighbors(envelope["matches"][0])["ok"]   # a single match dict
    assert helper.neighbors({"entity_id": "discovered:R1"})["ok"]  # entity_id dict


def test_coerce_ref_is_general():
    """_coerce_ref maps every shape an agent might pass to a bare ref string."""
    c = GraphHelper._coerce_ref
    assert c("R1") == "R1"
    assert c({"device_ref": "R1"}) == "R1"
    assert c({"entity_id": "ssh:10.0.0.1"}) == "10.0.0.1"
    assert c({"matches": [{"device_ref": "R2"}]}) == "R2"
    assert c([{"device_ref": "R3"}]) == "R3"
    assert c(None) == ""


def test_neighbors_bridges_ip_and_hostname(helper):
    """A device asked for by mgmt IP resolves to edges keyed by hostname and
    vice-versa — the identity-bridging invariant, independent of any device."""
    from ccie_sidecar.agents import graph_helper as gh
    c = sqlite3.connect(str(gh._db_path()))
    c.execute("INSERT INTO ssh_connections VALUES ('9','EdgeSw','192.0.2.9','admin',22)")
    c.execute("INSERT INTO topology_edges VALUES (?, 'EdgeSw','Gi1','CoreSw','Gi2','cdp',500)",
              (GLOBAL_GRAPH,))
    c.commit(); c.close()
    assert [n["neighbor"] for n in helper.neighbors("192.0.2.9")["neighbors"]] == ["CoreSw"]
    assert [n["neighbor"] for n in helper.neighbors("EdgeSw")["neighbors"]] == ["CoreSw"]


def test_fact_recallable_across_aliases(helper):
    """A fact recorded under the mgmt IP is recallable by hostname — general
    memory-identity invariant, so recall works regardless of phrasing."""
    from ccie_sidecar.agents import graph_helper as gh
    c = sqlite3.connect(str(gh._db_path()))
    c.execute("INSERT INTO ssh_connections VALUES ('7','DistSw','198.51.100.7','admin',22)")
    c.commit(); c.close()
    helper.record_fact("198.51.100.7", "role", "distribution-switch")
    facts = helper.query_facts("DistSw")["facts"]  # recall by the hostname alias
    assert any(f["value"] == "distribution-switch" for f in facts)


def test_install_graph_registers_global_and_module():
    g = {}
    install_graph(g)
    assert "graph" in g
    import graph as graph_mod  # registered in sys.modules
    assert hasattr(graph_mod, "neighbors")
    assert hasattr(graph_mod, "record_fact")
    assert hasattr(graph_mod, "recall")
    assert callable(g["graph"].help)


# -- Phase B: temporal memory ----------------------------------------------


def test_record_and_query_fact(helper):
    assert helper.record_fact("PE2", "bgp_state", "established")["ok"]
    res = helper.query_facts("pe2")  # case-insensitive
    assert res["ok"]
    assert len(res["facts"]) == 1
    assert res["facts"][0]["value"] == "established"
    assert res["facts"][0]["valid_to"] is None


def test_fact_supersede_preserves_history(helper):
    helper.record_fact("PE2", "bgp_state", "idle")
    helper.record_fact("PE2", "bgp_state", "established")
    # current view: only the latest
    current = helper.query_facts("PE2")["facts"]
    assert len(current) == 1
    assert current[0]["value"] == "established"
    # history view: both, old one has valid_to stamped
    hist = helper.query_facts("PE2", include_history=True)["facts"]
    assert len(hist) == 2
    superseded = [f for f in hist if f["value"] == "idle"][0]
    assert superseded["valid_to"] is not None


def test_record_fact_requires_fields(helper):
    assert helper.record_fact("", "k", "v")["ok"] is False
    assert helper.record_fact("e", "", "v")["ok"] is False


def test_record_and_recall_decision(helper):
    assert helper.record_decision(
        context="PE2 flapping during maintenance",
        decision="raised BGP hold timer to 180s",
        rationale="link latency spikes were tearing down the session",
        entities=["PE2"],
        cr_ref="CR-1234",
    )["ok"]
    res = helper.recall("hold timer")
    assert res["ok"]
    assert len(res["decisions"]) == 1
    assert res["decisions"][0]["cr_ref"] == "CR-1234"
    # also findable by entity
    assert len(helper.recall("pe2")["decisions"]) == 1


def test_recall_requires_query(helper):
    assert helper.recall("")["ok"] is False


def test_remember_alias_and_freshness(helper):
    """graph.remember stores a fact about ANY entity; a just-written fact is
    fresh (not stale) under the default 2h window. General, not device-specific."""
    helper.remember("anything-42", "note", "hello")   # arbitrary entity id
    qf = helper.query_facts("anything-42")
    assert qf["facts"][0]["value"] == "hello"
    assert qf["facts"][0]["stale"] is False            # fresh by default 2h
    assert qf["any_fresh"] is True
    assert qf["staleness_window_secs"] == 7200


def test_staleness_flags_old_fact(helper):
    """A fact older than the window reads back stale (age > window)."""
    from ccie_sidecar.agents import graph_helper as gh
    # Insert a fact 3 hours old directly (older than the 2h default window).
    conn = sqlite3.connect(str(gh._db_path()))
    old = int(conn.execute("SELECT strftime('%s','now')").fetchone()[0]) - 3 * 3600
    conn.execute(
        "INSERT INTO graph_facts (entity, key, value, valid_from, created_at) "
        "VALUES ('roamer', 'seen', 'yes', ?, ?)", (old, old),
    )
    conn.commit(); conn.close()
    qf = helper.query_facts("roamer")
    assert qf["facts"][0]["stale"] is True
    assert qf["any_fresh"] is False


def test_staleness_secs_env_and_default(monkeypatch):
    """feature_flags.staleness_secs: env wins, else default 2h."""
    from ccie_sidecar import feature_flags as ff
    monkeypatch.setenv("CCIE_CONTEXT_GRAPH_STALENESS_SECS", "900")
    assert ff.staleness_secs() == 900
    monkeypatch.delenv("CCIE_CONTEXT_GRAPH_STALENESS_SECS", raising=False)
    # no env, no db flag -> 2h default
    assert ff.staleness_secs() == 7200


def test_known_facts_note_is_index_driven(helper):
    """Index-driven recall: the note lists all fresh facts (grouped by entity)
    regardless of the question's phrasing, so 'secure endpoint' finds a fact
    stored under 'secure_endpoint'. Empty only when nothing is stored."""
    from ccie_sidecar.agents.graph_helper import known_facts_note
    # Empty DB -> no note (zero tokens on a fresh install).
    assert known_facts_note("anything") == ""
    helper.remember("secure_endpoint", "computer_count", "1")
    helper.remember("192.0.2.55", "role", "core-router")
    # ANY phrasing surfaces the index (this is the phrasing-brittleness fix).
    for q in ["show endpoints in secure endpoint", "weather", ""]:
        note = known_facts_note(q)
        assert "secure_endpoint:" in note
        assert "computer_count: 1" in note
        assert "192.0.2.55:" in note
        assert "role: core-router" in note


def test_known_facts_note_only_fresh(helper):
    """Stale facts (older than the window) are excluded from the index."""
    from ccie_sidecar.agents.graph_helper import known_facts_note
    from ccie_sidecar.agents import graph_helper as gh
    helper.remember("freshhost", "k", "v")  # current
    conn = sqlite3.connect(str(gh._db_path()))
    old = int(conn.execute("SELECT strftime('%s','now')").fetchone()[0]) - 3 * 3600
    conn.execute(
        "INSERT INTO graph_facts (entity, key, value, valid_from, created_at) "
        "VALUES ('stalehost', 'k', 'v', ?, ?)", (old, old),
    )
    conn.commit(); conn.close()
    note = known_facts_note("anything")
    assert "freshhost:" in note        # fresh included
    assert "stalehost" not in note     # 3h > 2h window -> excluded


def test_known_facts_note_clips_bulk_value(helper):
    """A bulk-dump value is clipped so it can't blow up the prompt."""
    from ccie_sidecar.agents.graph_helper import known_facts_note
    helper.remember("bulkhost", "dump", "x" * 5000)
    note = known_facts_note("anything")
    assert "bulkhost:" in note
    assert "…" in note                 # clipped marker present
    assert len(note) < 5000            # not the full 5000-char blob


def test_memory_missing_tables_fail_soft(tmp_path, monkeypatch):
    # DB exists but has NO graph_facts/graph_decisions (feature tables absent).
    db = tmp_path / "bare.db"
    sqlite3.connect(str(db)).close()
    monkeypatch.setattr(graph_helper, "_db_path", lambda: db)
    h = GraphHelper()
    qf = h.query_facts("R1")
    assert qf["ok"] is True and qf["facts"] == [] and qf["any_fresh"] is False
    assert h.recall("x") == {"ok": True, "decisions": [], "error": None}
    # writes fail soft with an error flag, never raise
    assert h.record_fact("R1", "k", "v")["ok"] is False


# --- Memory-first preamble (make agents check KNOWN FACTS before live calls) ---

def test_memory_first_preamble_gated(monkeypatch):
    """The preamble is present only when the context-graph flag is on."""
    from ccie_sidecar.agents import graph_helper as gh
    monkeypatch.setenv("CCIE_CONTEXT_GRAPH", "1")
    assert "MEMORY-FIRST" in gh.memory_first_preamble()
    monkeypatch.setenv("CCIE_CONTEXT_GRAPH", "0")
    assert gh.memory_first_preamble() == ""


def test_deepagents_tool_description_has_preamble(monkeypatch):
    """The deepagents execute_python_code tool description carries the memory-first
    line ABOVE the vendor 'your ONLY way' text when the flag is on, and not when off."""
    from ccie_sidecar.agents.deepagents_tools import create_execute_python_code_tool
    monkeypatch.setenv("CCIE_CONTEXT_GRAPH", "1")
    t = create_execute_python_code_tool("secure_endpoint", {}, lambda e: None)
    assert "MEMORY-FIRST" in t.description
    monkeypatch.setenv("CCIE_CONTEXT_GRAPH", "0")
    t_off = create_execute_python_code_tool("secure_endpoint", {}, lambda e: None)
    assert "MEMORY-FIRST" not in t_off.description


def test_all_builders_reference_preamble():
    """Guard: EVERY tool-description builder injects the memory-first preamble,
    so the fix can't silently drop from one path. Includes the architect's own
    builder (architect_subagents), which is a separate 4th path. Source-level."""
    import pathlib
    base = pathlib.Path(__file__).resolve().parents[2] / "src" / "ccie_sidecar" / "agents"
    for fname in ("deepagents_tools.py", "code_exec.py", "react_code.py",
                  "architect_subagents.py"):
        src = (base / fname).read_text()
        assert "memory_first_preamble" in src, f"{fname} missing preamble injection"


# --- Pinned ("remember forever") facts survive the staleness window ----------

def test_pinned_fact_survives_window(helper, monkeypatch):
    """A forever=True fact stays in the index past the staleness window; a plain
    fact of the same age drops out."""
    from ccie_sidecar.agents import graph_helper as gh
    helper.remember("exampleorg", "network_ids", "L_123", forever=True)
    helper.remember("tempthing", "status", "online")  # plain
    # Backdate both to 10s ago and force a 1s window.
    conn = sqlite3.connect(str(gh._db_path()))
    old = int(conn.execute("SELECT strftime('%s','now')").fetchone()[0]) - 10
    conn.execute("UPDATE graph_facts SET valid_from = ?", (old,))
    conn.commit(); conn.close()
    monkeypatch.setattr(gh, "_staleness_secs", lambda: 1)
    note = gh.known_facts_note("anything")
    assert "exampleorg" in note        # pinned survives
    assert "tempthing" not in note    # plain expired


def test_pinned_flag_in_query_facts(helper):
    helper.remember("orgx", "org_id", "155503", forever=True)
    qf = helper.query_facts("orgx")
    f = qf["facts"][0]
    assert f["pinned"] is True
    assert f["stale"] is False


def test_plain_remember_not_pinned(helper):
    helper.remember("orgy", "note", "hi")  # no forever
    qf = helper.query_facts("orgy")
    assert qf["facts"][0]["pinned"] is False
