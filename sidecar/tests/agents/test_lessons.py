"""Tests for the agent-lessons self-learning layer.

Builds a temp sessions.db from the real V0082 migration, toggles the
``ccie_agent_lessons`` flag via monkeypatch, and exercises injection
(``lessons_blurb``), the passive ``LessonObserver`` (including a replay of four
REAL error->recovery traces mined from agent_exec.jsonl), and the gated
``distill_and_store`` capture path with ``_invoke_llm`` stubbed offline.
"""
import pathlib
import sqlite3

import pytest

from ccie_sidecar.agents import lessons
from ccie_sidecar.agents.lessons import (
    LessonObserver,
    distill_and_store,
    lessons_blurb,
    record_lesson,
)

_MIGRATIONS = pathlib.Path(__file__).resolve().parents[3] / "src-tauri" / "migrations"


def _seed_db(path: str) -> None:
    conn = sqlite3.connect(path)
    conn.executescript((_MIGRATIONS / "V0082__agent_lessons.sql").read_text())
    conn.commit()
    conn.close()


@pytest.fixture()
def db(tmp_path, monkeypatch):
    """Temp sessions.db with the agent_lessons table and the flag ON."""
    path = tmp_path / "sessions.db"
    _seed_db(str(path))
    monkeypatch.setattr(lessons, "_db_path", lambda: path)
    monkeypatch.setattr(lessons, "_enabled", lambda: True)
    return path


# ---------------------------------------------------------------------------
# INJECTION — lessons_blurb
# ---------------------------------------------------------------------------

def test_blurb_empty_when_flag_off(tmp_path, monkeypatch):
    path = tmp_path / "sessions.db"
    _seed_db(str(path))
    monkeypatch.setattr(lessons, "_db_path", lambda: path)
    monkeypatch.setattr(lessons, "_enabled", lambda: False)
    record_lesson("some lesson", scope="meraki")  # no-op path is _enabled-independent for storage
    assert lessons_blurb("meraki") == ""  # byte-identical: nothing injected


def test_blurb_empty_when_no_lessons(db):
    assert lessons_blurb("meraki") == ""  # fresh DB -> zero tokens


def test_blurb_returns_scope_and_global(db):
    record_lesson("Meraki pagination goes in query_params, not a kwarg", scope="meraki")
    record_lesson("Inspect the response shape before assuming dict keys", scope="global")
    record_lesson("Splunk needs a literal search prefix", scope="splunk")  # other scope
    blurb = lessons_blurb("meraki")
    assert "LESSONS LEARNED" in blurb
    assert "query_params" in blurb          # scope match
    assert "Inspect the response shape" in blurb  # global always included
    assert "Splunk" not in blurb            # other scope excluded


def test_blurb_none_scope_is_global_only(db):
    record_lesson("A global rule", scope="global")
    record_lesson("A meraki rule", scope="meraki")
    blurb = lessons_blurb(None)
    assert "A global rule" in blurb
    assert "A meraki rule" not in blurb


def test_blurb_clips_long_lessons(db):
    record_lesson("x" * 500, scope="global")
    blurb = lessons_blurb("global")
    assert "…" in blurb
    assert "x" * 500 not in blurb


def test_catalog_grounded_blurb_omits_obsolete_discovery_and_raw_http_lessons(db):
    record_lesson(
        "Before calling any API endpoint, run api_catalog.search() first",
        scope="global",
    )
    record_lesson(
        "Use requests with the API key header for every call",
        scope="meraki",
    )
    record_lesson(
        "Pass array query params as lists and validate response shapes",
        scope="meraki",
    )

    blurb = lessons_blurb("meraki", catalog_grounded=True)

    assert "api_catalog.search()" not in blurb
    assert "API key header" not in blurb
    assert "Pass array query params as lists" in blurb


# ---------------------------------------------------------------------------
# CAPTURE — LessonObserver (with REAL log traces)
# ---------------------------------------------------------------------------

def test_observer_forwards_events_unchanged():
    seen = []
    obs = LessonObserver(lambda e: seen.append(e))
    events = [
        {"type": "tool_call", "name": "execute_python_code"},
        {"type": "tool_result", "success": False, "result": "Error: boom"},
        {"type": "final", "response": "done"},
    ]
    for e in events:
        obs.__call__(e)
    assert seen == events  # byte-for-byte passthrough


def test_observer_handles_none_inner():
    obs = LessonObserver(None)
    obs.__call__({"type": "tool_result", "success": True, "result": "ok"})  # must not raise


def test_observer_all_success_no_recovery():
    obs = LessonObserver(None)
    obs.__call__({"type": "tool_result", "success": True, "result": "ok"})
    obs.__call__({"type": "tool_result", "success": True, "result": "ok2"})
    assert obs.had_error_then_recovery() is False


def test_observer_all_failure_no_recovery():
    obs = LessonObserver(None)
    obs.__call__({"type": "tool_result", "success": False, "result": "Error: a"})
    obs.__call__({"type": "tool_result", "success": False, "result": "Error: b"})
    assert obs.had_error_then_recovery() is False


# Four REAL error->recovery traces mined from
# ~/Library/Application Support/ccie-terminal/logs/agent_exec.jsonl — each is a
# recurring failure the lessons layer is meant to prevent.
_REAL_TRACES = [
    (  # meraki: total_pages kwarg (seen 3x)
        "TypeError: install_meraki.<locals>.meraki_api_call() got an unexpected keyword argument 'total_pages'",
        "OK: fetched device statuses via query_params={'total_pages':'all'}",
    ),
    (  # meraki: pandas not in sandbox (seen 5x)
        "ModuleNotFoundError: No module named 'pandas'",
        "OK: built the report with plain json/dicts",
    ),
    (  # meraki: assumed dict shape (seen 9x)
        "AttributeError: 'str' object has no attribute 'get'",
        "OK: pprint'd the response first, then indexed the real shape",
    ),
    (  # network-architect/mist: KeyError 'orgs' (seen 3x)
        "KeyError: 'orgs'",
        "OK: dumped /api/v1/self, read the real key layout",
    ),
]


@pytest.mark.parametrize("failure,success", _REAL_TRACES)
def test_observer_flags_real_error_recovery(failure, success):
    obs = LessonObserver(None)
    obs.__call__({"type": "tool_result", "success": False, "result": failure})
    obs.__call__({"type": "tool_result", "success": True, "result": success})
    obs.__call__({"type": "final", "response": "answer"})
    assert obs.had_error_then_recovery() is True
    pair = obs.failure_then_success_pair()
    assert pair == (failure, success)


def test_observer_detects_error_in_deepagents_success_string():
    # REAL deepagents shape (caught by live test #5): execute_python_code returns
    # an "Error: ..." STRING with success=True because the ToolMessage didn't
    # raise. The observer must treat the content as a failure, not the boolean.
    obs = LessonObserver(None)
    obs.__call__({
        "type": "tool_result",
        "success": True,
        "result": "Error: TypeError: '<' not supported between instances of 'NoneType' and 'str'\nTraceback (most recent call last):\n  File ...",
    })
    obs.__call__({"type": "tool_result", "success": True, "result": "Total devices: 151\nOnline: 0"})
    assert obs.had_error_then_recovery() is True
    failure, recovered = obs.failure_then_success_pair()
    assert failure.startswith("Error: TypeError")
    assert "Total devices" in recovered


def test_observer_grader_ok_not_treated_as_error():
    # The RubricMiddleware grader result contains "criteria" but no error marker;
    # a clean grade must NOT be misread as a failure.
    obs = LessonObserver(None)
    obs.__call__({"type": "tool_result", "success": True, "result": "✓ Grading passed (2/2 criteria)"})
    assert obs.had_error_then_recovery() is False


def test_observer_collects_all_errors_and_final():
    # distill gets ALL errors + the final answer (not a brittle first pair), so
    # it can skip a throwaway syntax error and pick the real API lesson.
    obs = LessonObserver(None)
    obs.__call__({"type": "tool_result", "success": True, "result": "Error: SyntaxError: '(' was never closed"})
    obs.__call__({"type": "tool_result", "success": True, "result": "Error: KeyError: 'type'"})
    obs.__call__({"type": "tool_result", "success": True, "result": "OK: used productType field"})
    obs.__call__({"type": "final", "response": "151 devices, all reachable"})
    errs = obs.error_results()
    assert len(errs) == 2
    assert "SyntaxError" in errs[0] and "KeyError" in errs[1]
    assert obs.final_text == "151 devices, all reachable"


# ---------------------------------------------------------------------------
# CAPTURE — distill_and_store (offline, _invoke_llm stubbed)
# ---------------------------------------------------------------------------

def _obs_with_recovery():
    obs = LessonObserver(None)
    obs.__call__({"type": "tool_result", "success": False, "result": "Error: total_pages kwarg"})
    obs.__call__({"type": "tool_result", "success": True, "result": "OK via query_params"})
    return obs


def test_distill_noop_when_flag_off(tmp_path, monkeypatch):
    path = tmp_path / "sessions.db"
    _seed_db(str(path))
    monkeypatch.setattr(lessons, "_db_path", lambda: path)
    monkeypatch.setattr(lessons, "_enabled", lambda: False)
    called = []
    monkeypatch.setattr(
        "ccie_sidecar.troubleshoot.narrator._invoke_llm",
        lambda *a, **k: called.append(1) or "should not be used",
    )
    distill_and_store(_obs_with_recovery(), "meraki", "list devices")
    assert called == []  # flag off -> no LLM call, no row


def test_distill_noop_when_no_recovery(db, monkeypatch):
    called = []
    monkeypatch.setattr(
        "ccie_sidecar.troubleshoot.narrator._invoke_llm",
        lambda *a, **k: called.append(1) or "lesson",
    )
    obs = LessonObserver(None)
    obs.__call__({"type": "tool_result", "success": True, "result": "ok"})
    distill_and_store(obs, "meraki", "list devices")
    assert called == []


def test_distill_stores_lesson_on_recovery(db, monkeypatch):
    monkeypatch.setattr(
        "ccie_sidecar.troubleshoot.narrator._invoke_llm",
        lambda *a, **k: "Pass Meraki pagination via query_params, not as a kwarg",
    )
    distill_and_store(_obs_with_recovery(), "meraki", "list devices")
    blurb = lessons_blurb("meraki")
    assert "query_params" in blurb  # captured and now injectable


def test_distill_none_reply_stores_nothing(db, monkeypatch):
    monkeypatch.setattr(
        "ccie_sidecar.troubleshoot.narrator._invoke_llm",
        lambda *a, **k: "NONE",
    )
    distill_and_store(_obs_with_recovery(), "meraki", "list devices")
    assert lessons_blurb("meraki") == ""  # no durable lesson -> no row


def test_distill_cleans_reasoning_and_prefix(db, monkeypatch):
    # Reasoning models prepend blank lines / a stray thought and echo a label;
    # _clean_lesson must take the conclusion line and strip the prefix.
    monkeypatch.setattr(
        "ccie_sidecar.troubleshoot.narrator._invoke_llm",
        lambda *a, **k: "\n\nLet me think about this.\nLesson: pprint the response shape first",
    )
    distill_and_store(_obs_with_recovery(), "meraki", "inspect")
    conn = sqlite3.connect(str(db))
    stored = conn.execute("SELECT lesson FROM agent_lessons WHERE scope='meraki'").fetchone()[0]
    conn.close()
    assert stored == "pprint the response shape first"


# ---------------------------------------------------------------------------
# record_lesson — dedupe
# ---------------------------------------------------------------------------

def test_record_lesson_dedupes(db):
    assert record_lesson("same rule", scope="global") is True
    assert record_lesson("same rule", scope="global") is False  # UNIQUE(scope, lesson)
    # Same text under a different scope is a distinct lesson.
    assert record_lesson("same rule", scope="meraki") is True


def test_record_lesson_empty_is_noop(db):
    assert record_lesson("", scope="global") is False
    assert lessons_blurb("global") == ""
