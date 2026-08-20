"""Agent lessons — a self-learning "second brain" for the code-exec agents.

Persist durable *behavioral* lessons outside the model and feed them back on
every run (the Karpathy "LLM wiki" mechanism, DB-only, no Obsidian/markdown).

Two mechanisms, both gated by the ``ccie_agent_lessons`` flag and both no-ops
when it is off (so the assembled prompt is byte-identical to the pre-feature
build):

1. INJECTION (``lessons_blurb``): at loop start, append a short "LESSONS
   LEARNED" block to the agent's system prompt, filtered to the running agent's
   scope (its vendor/tool id) plus 'global'. This is *additive guidance* — it
   competes with nothing, unlike the read-side ID-shortcut directive that
   failed live verification (commit 74e14c8).

2. CAPTURE (``LessonObserver`` + ``distill_and_store``): a passive wrapper
   around the loop's ``on_event`` callback records tool successes/failures
   without changing behavior. When a turn shows an error->recovery pattern, one
   gated LLM call distills a one-line reusable lesson and stores it.

Every path is wrapped so any failure (DB locked, LLM down, schema drift)
degrades to a no-op — this module must never raise into the agent loop.

Storage: the ``agent_lessons`` table in sessions.db (migration V0082). The
UNIQUE(scope, lesson) constraint dedupes at the DB layer.
"""
from __future__ import annotations

import sqlite3
import types
from typing import Any, Callable, Dict, List, Optional, Tuple


def _enabled() -> bool:
    """True when the agent-lessons feature is on; False on any import error."""
    try:
        from ccie_sidecar.feature_flags import agent_lessons_enabled
        return agent_lessons_enabled()
    except Exception:
        return False


def _db_path():
    """Resolve sessions.db the same way the flag reader does."""
    from ccie_sidecar.feature_flags import _db_path as _p
    return _p()


def _connect() -> Optional[sqlite3.Connection]:
    try:
        db = _db_path()
        if not db.exists():
            return None
        conn = sqlite3.connect(str(db), timeout=3.0)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception:
        return None


# Sandbox failures surface as result strings in the deepagents path (the tool
# returns "Error: ..." rather than raising). Match the shapes code_exec /
# deepagents_tools actually emit so error->recovery detection works there too.
_ERROR_MARKERS = (
    "error:",              # "Error: ...", "Tool execution error: ..."
    "error fetching",      # partial-failure loops seen live ("Error fetching X: ...")
    "traceback (most recent call last)",
)


def _looks_like_error(result: str) -> bool:
    if not result:
        return False
    head = result.lstrip()[:400].lower()
    return any(marker in head for marker in _ERROR_MARKERS)


def _scopes(scope: Optional[str]) -> List[str]:
    """The scope filter for a run: the agent's tool id plus 'global'.

    Guards the None/empty case (a plain sandbox with no vendor) → 'global' only.
    """
    scope = (scope or "").strip()
    return [scope, "global"] if scope and scope != "global" else ["global"]


# ---------------------------------------------------------------------------
# 1. INJECTION
# ---------------------------------------------------------------------------

_OBSOLETE_CATALOG_LESSON_MARKERS = (
    "api_catalog.",
    "raw requests",
    "use requests",
    "api key header",
    "api_key header",
    "authorization header",
    "inspect.signature",
    "inspect the helper",
    "inspect helper",
    "enumerate the catalog",
)


def _obsolete_for_catalog_grounding(lesson: str) -> bool:
    lowered = lesson.lower()
    return any(marker in lowered for marker in _OBSOLETE_CATALOG_LESSON_MARKERS)


def lessons_blurb(
    scope: Optional[str],
    max_lessons: int = 12,
    *,
    catalog_grounded: bool = False,
) -> str:
    """Return a LESSONS LEARNED block for the prompt, or "".

    Empty string when the flag is off OR nothing is stored for this scope — so
    token cost is zero on a fresh DB (same contract as known_facts_note). Each
    lesson is clipped so a runaway row can't blow up the prompt. Newest first.
    """
    if not _enabled():
        return ""
    try:
        conn = _connect()
        if conn is None:
            return ""
        try:
            scopes = _scopes(scope)
            placeholders = ",".join("?" for _ in scopes)
            # Read past potentially obsolete rows so filtering cannot hide a
            # newer valid lesson merely because stale discovery advice occupied
            # the SQL LIMIT. Prompt output remains capped by max_lessons below.
            fetch_limit = max_lessons * 4 if catalog_grounded else max_lessons
            rows = conn.execute(
                f"SELECT scope, lesson FROM agent_lessons "
                f"WHERE scope IN ({placeholders}) "
                f"ORDER BY created_at DESC LIMIT ?",
                (*scopes, fetch_limit),
            ).fetchall()
        finally:
            conn.close()
        if not rows:
            return ""
        lines: List[str] = []
        for row in rows:
            lesson = str(row["lesson"]).strip()
            if catalog_grounded and _obsolete_for_catalog_grounding(lesson):
                continue
            if len(lesson) > 200:
                lesson = lesson[:200] + "…"
            lines.append(f"  - {lesson}")
            if len(lines) >= max_lessons:
                break
        if not lines:
            return ""
        return (
            "\n\nLESSONS LEARNED (from prior runs on this platform — apply when "
            "relevant; they are corrections to mistakes made before):\n"
            + "\n".join(lines)
        )
    except Exception:
        return ""  # never break prompt assembly


# ---------------------------------------------------------------------------
# 2. CAPTURE
# ---------------------------------------------------------------------------

class LessonObserver:
    """Passive wrapper around a loop's ``on_event`` callback.

    Forwards every event unchanged (zero behavior change) while recording the
    (success, result) of each ``tool_result`` and the text of the ``final``
    event. Lets CAPTURE observe the event stream instead of editing loop
    internals — the surgical seam.
    """

    def __init__(self, inner: Optional[Callable[[Dict[str, Any]], Any]]):
        self._inner = inner
        self._steps: List[Tuple[bool, str]] = []
        self.final_text: str = ""

    def __call__(self, event: Dict[str, Any]) -> Any:
        try:
            etype = event.get("type")
            if etype == "tool_result":
                result = event.get("result")
                result_str = str(result) if result is not None else ""
                # A step failed if the event flags it OR the result content is
                # an error. The deepagents path returns sandbox exceptions as an
                # "Error: ..." STRING with success=True (the ToolMessage didn't
                # raise), so the boolean alone misses them — key on content too.
                success = bool(event.get("success", False)) and not _looks_like_error(result_str)
                self._steps.append((success, result_str))
            elif etype == "final":
                self.final_text = str(event.get("response") or "")
        except Exception:
            pass  # observation must never disrupt the forwarded event
        if self._inner is not None:
            return self._inner(event)
        return None

    def had_error_then_recovery(self) -> bool:
        """True if a failed step was later followed by a successful one."""
        seen_failure = False
        for success, _ in self._steps:
            if not success:
                seen_failure = True
            elif seen_failure:
                return True
        return False

    def failure_then_success_pair(self) -> Optional[Tuple[str, str]]:
        """Return (first failure result, its recovering success result), or None."""
        first_failure: Optional[str] = None
        for success, result in self._steps:
            if not success and first_failure is None:
                first_failure = result
            elif success and first_failure is not None:
                return (first_failure, result)
        return None

    def error_results(self) -> List[str]:
        """All failed step results, in order."""
        return [r for ok, r in self._steps if not ok]


_DISTILL_PROMPT = (
    "You are maintaining a knowledge base of behavioral lessons for an AI agent "
    "that writes Python to call the '{scope}' platform's API in a sandbox.\n\n"
    "On this run the agent hit these ERRORS along the way but ultimately produced "
    "a correct answer:\n\n"
    "--- ERRORS ENCOUNTERED ---\n{errors}\n\n"
    "--- FINAL ANSWER (what worked) ---\n{final}\n\n"
    "Pick the SINGLE most valuable durable lesson that would let the agent avoid "
    "its biggest mistake next time, and write it as ONE short reusable rule "
    "(imperative voice, <=160 chars). Prefer API-shape / field-name / calling-"
    "convention lessons over one-off typos (e.g. a stray syntax error is NOT "
    "worth a lesson). Focus on what generalizes, not this run's specifics.\n\n"
    "Existing lessons for this scope (do NOT duplicate their meaning):\n{existing}\n\n"
    "If there is no durable, generalizable lesson, or it duplicates an existing "
    "one, reply with exactly: NONE\n\nLesson:"
)


def _clean_lesson(raw: str) -> str:
    """Normalize an LLM reply into one clean lesson line.

    Reasoning models often prepend blank lines / a stray reasoning sentence and
    echo a "Lesson:" label or bullet. Take the last non-empty line (the model's
    conclusion), strip common prefixes, and collapse whitespace.
    """
    if not raw:
        return ""
    lines = [ln.strip() for ln in raw.strip().splitlines() if ln.strip()]
    if not lines:
        return ""
    text = lines[-1]
    for prefix in ("Lesson:", "lesson:", "-", "•", "*"):
        if text.startswith(prefix):
            text = text[len(prefix):].strip()
    return " ".join(text.split())


def distill_and_store(observer: LessonObserver, scope: Optional[str], user_msg: str = "") -> None:
    """When a turn recovered from an error, distill and store one lesson.

    No-op unless the flag is on AND the observer saw an error->recovery. Fires
    exactly one small, gated LLM call (reusing the provider-agnostic
    ``_invoke_llm``). Runs in the post-final window, so the user's answer is
    already streamed — this never delays their response. Wrapped so it can
    never raise into the loop.
    """
    if not _enabled():
        return
    try:
        if not observer.had_error_then_recovery():
            return
        errors = observer.error_results()
        if not errors:
            return
        # Give the model ALL the turn's errors + the final answer and let it
        # pick the single most valuable durable lesson — more agentic and robust
        # than a brittle first-failure/next-success heuristic (which live testing
        # showed could latch onto a throwaway syntax error).
        errors_block = "\n".join(f"  {i+1}. {e[:400]}" for i, e in enumerate(errors[:6]))
        final = (observer.final_text or "(no final answer captured)")[:800]

        store_scope = (scope or "").strip() or "global"
        existing = _existing_lessons(store_scope)
        existing_block = "\n".join(f"  - {l}" for l in existing) or "  (none yet)"

        prompt = _DISTILL_PROMPT.format(
            scope=store_scope, errors=errors_block, final=final, existing=existing_block,
        )

        # max_tokens is large because reasoning models (e.g. the vLLM Ornith
        # default) spend the whole budget on chain-of-thought and emit EMPTY
        # content with finish_reason=length when starved. Measured live: 512 and
        # 1024 returned "" (truncated mid-reasoning); 2048 let it finish and
        # produce the one-line lesson. This call runs post-final so it never
        # delays the user's answer, making the larger budget cheap in practice.
        from ccie_sidecar.troubleshoot.narrator import _invoke_llm
        reply = _clean_lesson(_invoke_llm(prompt, max_tokens=2048, temperature=0.1))

        if not reply or reply.upper().startswith("NONE"):
            return
        record_lesson(reply, scope=store_scope, source="auto")
    except Exception:
        return  # capture must never disrupt the loop


def _existing_lessons(scope: str, limit: int = 20) -> List[str]:
    try:
        conn = _connect()
        if conn is None:
            return []
        try:
            rows = conn.execute(
                "SELECT lesson FROM agent_lessons WHERE scope = ? "
                "ORDER BY created_at DESC LIMIT ?",
                (scope, limit),
            ).fetchall()
        finally:
            conn.close()
        return [str(r["lesson"]) for r in rows]
    except Exception:
        return []


def record_lesson(text: str, scope: str = "global", source: str = "explicit") -> bool:
    """Store one lesson. INSERT OR IGNORE so a duplicate (scope, lesson) is a
    no-op. Returns True if a row was inserted. Never raises.
    """
    try:
        text = (text or "").strip()
        if not text:
            return False
        scope = (scope or "global").strip() or "global"
        conn = _connect()
        if conn is None:
            return False
        try:
            cur = conn.execute(
                "INSERT OR IGNORE INTO agent_lessons (scope, lesson, source) "
                "VALUES (?, ?, ?)",
                (scope, text, source),
            )
            conn.commit()
            return cur.rowcount > 0
        finally:
            conn.close()
    except Exception:
        return False


# ---------------------------------------------------------------------------
# Sandbox helper (explicit capture from agent code)
# ---------------------------------------------------------------------------

def install_lessons(globals_dict: Dict[str, Any], scope: Optional[str] = None) -> None:
    """Bind a `lessons` helper into the code sandbox when the flag is on.

    Mirrors install_graph. Exposes ``lessons.learn(text, scope=None)`` so an
    agent (or the operator, via a scratch cell) can record a lesson
    deliberately. No-op when the flag is off, so the sandbox globals are
    unchanged in the pre-feature build.
    """
    if not _enabled():
        return

    default_scope = (scope or "").strip() or None

    def learn(text: str, scope: Optional[str] = None) -> Dict[str, Any]:
        target = (scope or default_scope or "global")
        inserted = record_lesson(text, scope=target, source="explicit")
        return {"ok": True, "stored": inserted, "scope": target}

    helper = types.SimpleNamespace(learn=learn)
    globals_dict["lessons"] = helper

    module = types.ModuleType("lessons")
    module.learn = learn  # type: ignore[attr-defined]
    import sys
    sys.modules["lessons"] = module
