"""Plan 15 Phase 3 — AI narration + run conclusion.

This module is invoked by the Rust engine through the NDJSON sidecar
server (handlers `troubleshoot.narrate` and `troubleshoot.conclude`).

Design notes:
- Narration is ADVISORY. The Rust executor never blocks the engine on
  narration: a missing handler, an LLM error, a RAG miss — all degrade
  gracefully. So this module catches everything internally and returns
  a structured payload even on failure.
- RAG retrieval is optional (Plan 12). Many users have not indexed any
  docs; the import itself may fail, the search may return empty, or the
  LLM call may be deterministic. We handle each path independently.
- The two prompt templates are bundled as plain markdown files alongside
  this module so they round-trip through the wheel via hatchling's
  package include rules.
- Keep narrations 1-2 sentences (max_tokens=160 per Plan 15 spec).
- The LLM helper is the existing `ccie_sidecar.providers.anthropic.complete`
  surface; tests monkeypatch `_invoke_llm` so CI is deterministic.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any


_PROMPTS_DIR = Path(__file__).parent / "prompts"


def _load_prompt(name: str) -> str:
    """Load a prompt template by basename (e.g. 'troubleshoot_narrate.md')."""
    path = _PROMPTS_DIR / name
    return path.read_text(encoding="utf-8")


def _format_prompt(template_name: str, **fields: Any) -> str:
    """Render a prompt template by str.format-style placeholder substitution.

    All values are coerced through json.dumps when they aren't strings so
    the rendered prompt is always valid (and any embedded quotes are
    safely escaped). Missing keys raise KeyError loudly so prompt drift
    is caught in tests rather than silently producing a broken prompt.
    """
    tmpl = _load_prompt(template_name)
    rendered: dict[str, str] = {}
    for k, v in fields.items():
        if isinstance(v, str):
            rendered[k] = v
        else:
            try:
                rendered[k] = json.dumps(v, default=str, ensure_ascii=False)
            except Exception:
                rendered[k] = str(v)
    return tmpl.format(**rendered)


# ---------------------------------------------------------------------------
# RAG retrieval (Plan 12) — optional. The narrator works without it.
# ---------------------------------------------------------------------------

def _try_rag_search(query: str, k: int = 3) -> list[dict[str, Any]]:
    """Best-effort RAG search.

    The plan's reference path is `from ccie_sidecar.rag.client import
    search as rag_search`. That module does not exist yet (Plan 12
    landed Rust-side retrieval but no sidecar-side client). We try the
    import; if it fails OR the call fails OR returns nothing, we fall
    back to an empty list so narration always succeeds.

    Returns a list of dicts shaped like ``{"id": str, "text": str,
    "score": float}``. Callers only depend on the ``id`` field for
    citation extraction.
    """
    try:
        from ccie_sidecar.rag.client import search as rag_search  # type: ignore[attr-defined]
    except Exception:
        return []
    try:
        result = rag_search(query=query, k=k)
        if isinstance(result, list):
            return result
    except Exception:
        return []
    return []


# ---------------------------------------------------------------------------
# LLM invocation — wraps the existing provider surface so tests can mock.
# ---------------------------------------------------------------------------

def _collect_stream_text(stream: Any) -> str:
    """Concatenate ``{"type": "token", "data": ...}`` events from a
    provider ``stream_chat`` generator into a single string. Stops on the
    first error event (returns whatever was collected so far)."""
    parts: list[str] = []
    for event in stream:
        if not isinstance(event, dict):
            continue
        etype = event.get("type")
        if etype == "token":
            parts.append(str(event.get("data", "")))
        elif etype == "error":
            break
    return "".join(parts)


def _invoke_llm(prompt: str, max_tokens: int = 160, temperature: float = 0.1) -> str:
    """Synchronously invoke the user-configured LLM with a single prompt.

    Uses the SAME provider/model/key/base_url the chat panel uses —
    read from the app's SQLite ``ai_config`` table via
    ``agent.get_saved_config()`` — instead of hardcoding Anthropic. This
    is what makes troubleshoot conclusions actually populate for users on
    vLLM / Ollama / NVIDIA / OpenAI / Google, not just those with an
    ``ANTHROPIC_API_KEY`` env var set.

    IMPORTANT: this MUST be a fully synchronous call. ``narrate`` /
    ``conclude`` are async and the NDJSON server invokes them via
    ``asyncio.run(...)``, so calling ``asyncio.run(call_llm(...))`` here
    would raise "asyncio.run() cannot be called from a running event
    loop" — which silently degraded every conclusion to the default
    "Insufficient signal" placeholder. We therefore call each provider's
    synchronous helper directly (mirroring agent.py's dispatch).

    Falls back to empty string (the executor then uses the literal
    playbook narration text) when no provider is configured or the call
    fails. The test suite monkeypatches this function directly to keep CI
    offline.

    Note: `temperature` is accepted for API symmetry but the underlying
    provider helpers currently ignore it.
    """
    from ccie_sidecar.agent import get_saved_config

    saved = get_saved_config() or {}
    provider = saved.get("provider")
    model = saved.get("model")
    api_key = saved.get("api_key")
    base_url = saved.get("base_url")

    # No saved provider config -> fall back to an Anthropic env key if the
    # user happens to have one, else return empty (literal-text fallback).
    if not provider:
        if os.getenv("ANTHROPIC_API_KEY"):
            provider = "anthropic"
            model = model or "claude-sonnet-4-6"
        else:
            return ""

    model = model or ""
    messages = [{"role": "user", "content": prompt}]

    try:
        if provider == "anthropic":
            key = api_key or os.getenv("ANTHROPIC_API_KEY")
            if not key:
                return ""
            from ccie_sidecar.providers.anthropic import complete

            return complete(api_key=key, model=model, messages=messages, max_tokens=max_tokens)

        if provider == "openai":
            key = api_key or os.getenv("OPENAI_API_KEY")
            if not key:
                return ""
            from ccie_sidecar.providers.openai import complete

            return complete(api_key=key, model=model, messages=messages, max_tokens=max_tokens)

        if provider == "nvidia":
            key = api_key or os.getenv("NVIDIA_API_KEY")
            if not key:
                return ""
            from ccie_sidecar.providers.nvidia import complete

            return complete(api_key=key, model=model, messages=messages, max_tokens=max_tokens)

        if provider == "vllm":
            endpoint = base_url or os.getenv("VLLM_ENDPOINT", "http://localhost:8000")
            if not endpoint.rstrip("/").endswith("/v1"):
                endpoint = endpoint.rstrip("/") + "/v1"
            from ccie_sidecar.providers.vllm import complete

            return complete(
                endpoint=endpoint, model=model, messages=messages,
                api_key=api_key, max_tokens=max_tokens,
            )

        if provider == "ollama":
            host = base_url or os.getenv("OLLAMA_HOST", "http://localhost:11434")
            from ccie_sidecar.providers.ollama import stream_chat

            return _collect_stream_text(stream_chat(host=host, model=model, messages=messages))

        if provider == "google":
            key = api_key or os.getenv("GOOGLE_API_KEY")
            if not key:
                return ""
            from ccie_sidecar.providers.google import stream_chat

            return _collect_stream_text(
                stream_chat(api_key=key, model=model, messages=messages, max_tokens=max_tokens)
            )

        print(f"[troubleshoot.narrator] unsupported provider: {provider}")
        return ""
    except Exception as exc:  # pragma: no cover - defensive
        print(f"[troubleshoot.narrator] LLM invocation failed: {exc}")
        return ""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

async def narrate(
    step: dict[str, Any],
    parsed: Any,
    vars_: dict[str, Any] | None,
    vendor: str,
    platform: str,
) -> dict[str, Any]:
    """Produce a 1-2 sentence narration for a single step.

    Returns ``{"text": str, "citations": [str]}``. The text may be empty
    when no LLM is configured — the engine falls back to the literal
    playbook text in that case.
    """
    vars_ = vars_ or {}
    step_id = step.get("id", "")
    step_type = step.get("type", "")
    command = step.get("command", step.get("text", step.get("expression", "")))

    rag_snippets = _try_rag_search(
        query=f"{command} {vendor} {platform}".strip(),
        k=3,
    )

    prompt = _format_prompt(
        "troubleshoot_narrate.md",
        vendor=vendor,
        platform=platform,
        step_id=step_id,
        step_type=step_type,
        command=command,
        parsed_json=parsed if parsed is not None else {},
        vars=vars_,
        rag_snippets=[
            {"id": s.get("id"), "text": s.get("text", "")[:240]}
            for s in rag_snippets
        ],
    )

    try:
        # 2048 (not 512): reasoning models like Ornith / gpt-oss spend most of
        # their token budget on internal reasoning before emitting the visible
        # 1-2 sentence narration. At 512 the budget was exhausted mid-reasoning
        # so `content` came back empty and the panel showed "(no narration
        # text)". This mirrors `conclude`, which was bumped for the same reason.
        text = _invoke_llm(prompt, max_tokens=2048, temperature=0.1)
    except Exception:
        text = ""

    citations = [s.get("id") for s in rag_snippets if s.get("id")]
    return {"text": (text or "").strip(), "citations": citations}


async def conclude(
    run_history: list[dict[str, Any]],
    symptom: str,
    vendor: str,
    platform: str,
) -> dict[str, Any]:
    """Produce a structured conclusion for a finished run.

    Returns a dict with EXACTLY four fields:
      - root_cause      (str)
      - confidence      ("low" | "medium" | "high")
      - suggested_fix   (str)
      - evidence        (list[str])

    The function ALWAYS returns those four fields, even if the LLM
    fails or returns garbage — the Rust caller persists this verbatim
    into ``troubleshoot_runs.conclusion_json``, so a malformed payload
    would surface as a confusing UI bug. Defensive defaults: a generic
    "indeterminate" root_cause + low confidence.
    """
    prompt = _format_prompt(
        "troubleshoot_conclude.md",
        vendor=vendor,
        platform=platform,
        symptom=symptom,
        run_history_json=_summarize_run_history(run_history),
    )

    try:
        # 2048 (not 512): reasoning models like gpt-oss-120b spend tokens on
        # internal reasoning before the visible JSON, so a tight budget
        # truncated the answer mid-object and the parse fell back to the
        # "Insufficient signal" default.
        raw = _invoke_llm(prompt, max_tokens=2048, temperature=0.1)
    except Exception:
        raw = ""

    parsed = _safe_parse_conclusion(raw)
    return _coerce_conclusion(parsed, symptom=symptom)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Sensitive field names we drop / redact when summarizing run history for
# the LLM prompt. The redaction is belt-and-braces — playbooks should not
# put credentials into vars in the first place, but if a misuse happens
# the LLM should never see them. Matches are case-insensitive substring.
_SENSITIVE_KEYS = (
    "password", "secret", "token", "api_key", "apikey",
    "community", "psk", "pre_shared_key", "private_key",
    "credentials", "auth", "vault",
)


def _is_sensitive(key: str) -> bool:
    k = key.lower()
    return any(s in k for s in _SENSITIVE_KEYS)


def _redact_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            k: ("<redacted>" if _is_sensitive(k) else _redact_value(v))
            for k, v in value.items()
        }
    if isinstance(value, list):
        return [_redact_value(v) for v in value]
    return value


def _summarize_run_history(history: list[dict[str, Any]]) -> str:
    """Reduce the run history to a compact JSON string the LLM can read.

    We deliberately keep this short — the prompt has a finite context
    budget and most steps add little signal beyond ``step_id``,
    ``status``, and a short tail of the result. We also redact any
    sensitive-looking fields.
    """
    summary: list[dict[str, Any]] = []
    for s in history[-30:]:  # last 30 steps is plenty for a tree run
        result_json = s.get("result_json")
        if isinstance(result_json, dict):
            redacted = _redact_value(result_json)
            # Trim noisy fields
            for noisy in ("raw", "embedding", "stdout", "stderr"):
                if noisy in redacted:
                    val = redacted[noisy]
                    if isinstance(val, str) and len(val) > 240:
                        redacted[noisy] = val[:240] + "..."
        else:
            redacted = result_json
        summary.append(
            {
                "step_id": s.get("step_id"),
                "step_type": s.get("step_type"),
                "status": s.get("status"),
                "result": redacted,
            }
        )
    return json.dumps(summary, default=str, ensure_ascii=False)


def _safe_parse_conclusion(raw: str) -> dict[str, Any]:
    """Parse the LLM output as JSON. Strip markdown fences if present.

    Returns ``{}`` on parse failure so ``_coerce_conclusion`` can apply
    defaults.
    """
    if not raw:
        return {}
    text = raw.strip()
    # Strip ``` or ```json fences
    if text.startswith("```"):
        text = text.split("\n", 1)[1] if "\n" in text else text[3:]
        if text.endswith("```"):
            text = text[:-3]
        text = text.strip()
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            return value
    except json.JSONDecodeError:
        pass
    return {}


_CONFIDENCE_VALUES = ("low", "medium", "high")


def _coerce_conclusion(value: dict[str, Any], symptom: str) -> dict[str, Any]:
    """Force the conclusion shape so the Rust caller always sees four
    well-typed fields.
    """
    root_cause = value.get("root_cause")
    if not isinstance(root_cause, str) or not root_cause.strip():
        root_cause = (
            f"Indeterminate root cause for symptom: {symptom}. "
            "Insufficient signal in the captured run."
        )

    confidence = value.get("confidence", "low")
    if not isinstance(confidence, str):
        confidence = "low"
    confidence = confidence.lower().strip()
    if confidence not in _CONFIDENCE_VALUES:
        confidence = "low"

    suggested_fix = value.get("suggested_fix")
    if not isinstance(suggested_fix, str) or not suggested_fix.strip():
        suggested_fix = (
            "Re-run the playbook after collecting additional state. "
            "Escalate to a human operator if the symptom persists."
        )

    evidence = value.get("evidence", [])
    if not isinstance(evidence, list):
        evidence = []
    # Coerce each item to a string and trim
    evidence_str = [str(e)[:280] for e in evidence if e is not None]

    return {
        "root_cause": root_cause.strip(),
        "confidence": confidence,
        "suggested_fix": suggested_fix.strip(),
        "evidence": evidence_str,
    }
