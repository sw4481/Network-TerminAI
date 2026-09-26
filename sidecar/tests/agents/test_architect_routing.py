"""Tests for the Network Architect vendor-routing helpers.

These guard the three fixes for the "asked about ISE, got Mist" bug:
  1. history scoping (condense stale prior-turn answers about another vendor)
  2. deterministic routing hint (nudge the model toward the named platform)
  3. platform-aware rubric clause (grader fails a wrong-vendor answer)

The shared primitive is detect_vendor_ids — high-precision, whole-word matching
on brand/product aliases only. A miss must degrade to "no nudge / keep history",
never to a wrong route, so the false-positive guards below are the important part.
"""
from ccie_sidecar.agents.architect_subagents import (
    detect_vendor_ids,
    architect_routing_hint,
    scope_history_for_question,
    is_blender_only_request,
    build_architect_direct_tool,
)

CONFIGURED = ["mist", "ise", "meraki", "catalyst_center", "aci"]


# --- detect_vendor_ids ------------------------------------------------------

def test_detect_named_vendor():
    assert detect_vendor_ids("can you list my ISE authenticated devices", CONFIGURED) == ["ise"]
    assert detect_vendor_ids("list mist switches", CONFIGURED) == ["mist"]


def test_detect_ambiguous_returns_empty():
    # "devices" alone names no vendor — must NOT guess.
    assert detect_vendor_ids("show me all the devices", CONFIGURED) == []


def test_detect_word_boundary_no_false_positive():
    # 'ise' must not fire inside 'precise'/'wise'; 'aci' not inside 'basic'.
    assert detect_vendor_ids("give me a precise, wise summary", CONFIGURED) == []
    assert detect_vendor_ids("a basic overview", CONFIGURED) == []


def test_detect_respects_restrict_to():
    # Vendor named but not configured -> not returned.
    assert detect_vendor_ids("the aci fabric health", ["ise", "mist"]) == []
    assert detect_vendor_ids("the aci fabric health", ["aci"]) == ["aci"]


def test_detect_multiple_vendors_in_spec_order():
    hits = detect_vendor_ids("correlate ISE sessions with meraki clients", CONFIGURED)
    assert set(hits) == {"ise", "meraki"}


# --- architect_routing_hint -------------------------------------------------

def test_routing_hint_single_vendor():
    hint = architect_routing_hint("list my ISE authenticated devices", CONFIGURED)
    assert "ise" in hint and "prior turns" in hint.lower()


def test_routing_hint_empty_when_ambiguous():
    assert architect_routing_hint("show me all the devices", CONFIGURED) == ""


def test_routing_hint_multi_vendor():
    hint = architect_routing_hint("correlate ISE with meraki", CONFIGURED)
    assert "ise" in hint and "meraki" in hint


def test_routing_hint_blender_skips_vendor_catalog():
    hint = architect_routing_hint("check the Blender scene", CONFIGURED)
    assert "blender" in hint.lower()
    assert "execute_python_code" in hint
    assert "Do NOT call search_api_catalog" in hint


def test_blender_with_vendor_name_is_not_blender_only():
    assert is_blender_only_request("render Meraki topology in Blender", CONFIGURED) is False


def test_architect_tool_description_names_blender_helper():
    tool, _ = build_architect_direct_tool(
        include_unconfigured=False,
        catalogs=[],
        user_msg="check the Blender scene",
    )
    assert "blender.status()" in tool.description
    assert "pre-bound `blender` helper" in tool.description


# --- scope_history_for_question --------------------------------------------

def _mist_then_ise_history():
    return [
        {"role": "user", "content": "list mist switches"},
        {"role": "assistant", "content": "Here are the Juniper Mist switches: "
                                         "ISF_EX4300 EX4300-48P disconnected ..."},
    ]


def test_scope_condenses_other_vendor_answer():
    scoped = scope_history_for_question(
        _mist_then_ise_history(), "list my ISE authenticated devices", CONFIGURED
    )
    # User turn kept verbatim; the Mist assistant answer is stubbed out.
    assert scoped[0]["content"] == "list mist switches"
    assert "omitted" in scoped[1]["content"]
    assert "EX4300" not in scoped[1]["content"]


def test_scope_keeps_same_vendor_answer():
    scoped = scope_history_for_question(
        _mist_then_ise_history(), "show me more mist details", CONFIGURED
    )
    assert "EX4300" in scoped[1]["content"]  # same vendor -> untouched


def test_scope_noop_when_question_ambiguous():
    hist = _mist_then_ise_history()
    scoped = scope_history_for_question(hist, "what about its ports?", CONFIGURED)
    assert scoped == hist  # no vendor named -> preserve full context


def test_scope_keeps_generic_answer():
    hist = [
        {"role": "user", "content": "hi"},
        {"role": "assistant", "content": "Hello! How can I help with your network?"},
    ]
    scoped = scope_history_for_question(hist, "list my ISE devices", CONFIGURED)
    assert scoped == hist  # generic answer names no vendor -> keep


def test_scope_empty_history():
    assert scope_history_for_question([], "list ISE devices", CONFIGURED) == []


# --- platform-aware rubric (fix #3) ----------------------------------------

def test_rubric_adds_platform_clause_for_named_vendor():
    from ccie_sidecar.agents.deepagents_runtime import _platform_aware_rubric
    r = _platform_aware_rubric("list my ISE authenticated devices", ["ise", "mist"])
    assert "PLATFORM MATCH" in r
    assert "Cisco ISE" in r


def test_rubric_falls_back_when_ambiguous():
    from ccie_sidecar.agents.deepagents_runtime import (
        _platform_aware_rubric,
        TASK_COMPLETION_RUBRIC,
    )
    assert _platform_aware_rubric("show me all the devices", ["ise", "mist"]) == (
        TASK_COMPLETION_RUBRIC
    )


# --- keyword overrides (Settings-configurable) -----------------------------

import json
import sqlite3
import ccie_sidecar.agents.architect_subagents as arch


def _seed_overrides(tmp_path, monkeypatch, blob):
    """Point the override loader at a temp sessions.db holding `blob`."""
    db = tmp_path / "sessions.db"
    conn = sqlite3.connect(str(db))
    conn.execute(
        "CREATE TABLE app_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
    )
    if blob is not None:
        conn.execute(
            "INSERT INTO app_flags(key, value) VALUES ('ccie_vendor_keywords', ?)",
            (blob,),
        )
    conn.commit()
    conn.close()
    monkeypatch.setattr(arch, "_db_path", lambda: db)


def test_override_adds_new_alias(tmp_path, monkeypatch):
    _seed_overrides(tmp_path, monkeypatch,
                    json.dumps({"ise": ["ise", "my-campus-auth"]}))
    assert arch.detect_vendor_ids("check my-campus-auth sessions", ["ise"]) == ["ise"]


def test_override_replaces_and_drops_builtin(tmp_path, monkeypatch):
    # Override ISE with a list that omits the word "radius".
    _seed_overrides(tmp_path, monkeypatch, json.dumps({"ise": ["ise"]}))
    # "radius" no longer routes to ISE (built-in replaced).
    assert arch.detect_vendor_ids("radius timeout", ["ise"]) == []
    # A different vendor is untouched by an ISE-only override.
    assert arch.detect_vendor_ids("list mist wlans", ["mist"]) == ["mist"]


def test_override_malformed_json_falls_back(tmp_path, monkeypatch):
    _seed_overrides(tmp_path, monkeypatch, "{not valid json")
    assert arch.detect_vendor_ids("list my ISE devices", ["ise"]) == ["ise"]


def test_override_missing_db_uses_builtins(tmp_path, monkeypatch):
    monkeypatch.setattr(arch, "_db_path", lambda: tmp_path / "nope.db")
    assert arch.detect_vendor_ids("list my ISE devices", ["ise"]) == ["ise"]


def test_override_unknown_vendor_ignored(tmp_path, monkeypatch):
    _seed_overrides(tmp_path, monkeypatch,
                    json.dumps({"bogus": ["x"], "ise": ["ise", "widget"]}))
    eff = arch.effective_keywords()
    assert "bogus" not in eff
    assert "widget" in eff["ise"]


# --- defaults export (frontend reads a file, not a mid-turn RPC) ------------

def test_keyword_defaults_payload_all_vendors():
    payload = arch.keyword_defaults_payload()
    ids = [v["id"] for v in payload["vendors"]]
    assert ids == [s["id"] for s in arch.VENDOR_SPECS]  # all vendors, spec order
    ise = next(v for v in payload["vendors"] if v["id"] == "ise")
    assert ise["display"] == "Cisco ISE (identity)"
    assert "radius" in ise["keywords"]


def test_write_defaults_file_roundtrip(tmp_path, monkeypatch):
    # Redirect the config dir to tmp so we don't touch the real one.
    monkeypatch.setattr(arch, "_db_path", lambda: tmp_path / "sessions.db")
    assert arch.write_vendor_keyword_defaults_file() is True
    path = arch.vendor_keyword_defaults_path()
    assert path.exists()
    data = json.loads(path.read_text())
    assert len(data["vendors"]) == len(arch.VENDOR_SPECS)
    assert data == arch.keyword_defaults_payload()


def test_write_defaults_file_soft_fails_on_bad_dir(monkeypatch, tmp_path):
    # Unwritable path -> returns False, never raises (RPC fallback still covers it).
    # Put the db under an existing *regular file* so mkdir(parents=True) fails
    # (NotADirectoryError) on every OS — the old "/dev/null/nope" trick is
    # Unix-only (on Windows mkdir would just create the dirs and the test'd fail).
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("x")
    bad_db = blocker / "nope" / "sessions.db"
    monkeypatch.setattr(arch, "_db_path", lambda: bad_db)
    assert arch.write_vendor_keyword_defaults_file() is False
