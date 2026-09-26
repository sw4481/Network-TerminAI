"""IaC Phase 3 — AI drift explanation.

Turns the Rust-detected drifted resources + raw plan output into per-resource
prose. This is the ONLY Python piece of Phase 3; everything else is Rust. It is
called best-effort over the Rust->Python RPC `iac.analyze_drift`. ANY failure
returns an empty, `unavailable`-flagged result so the frontend still renders the
raw diff — drift visibility must never depend on the LLM being up.
"""
from __future__ import annotations

import json
from typing import Any, Callable, Optional

# An injectable text-in/text-out LLM call (real one wired by the RPC handler).
LlmFn = Callable[[str], str]


def _build_prompt(drifted: list[dict], plan_output: str) -> str:
    return (
        "Analyze the following Terraform drift (resources changed outside "
        "Terraform). For each, explain what changed, the likely cause, a "
        "recommended action (import|revert|exception), and the impact.\n\n"
        f"Drifted resources:\n{json.dumps(drifted, indent=2)}\n\n"
        f"Plan output (truncated):\n{plan_output[:4000]}\n\n"
        'Respond as JSON: {"analyses": [{"resource": "...", "explanation": "...", '
        '"cause": "...", "recommendation": "import|revert|exception", "impact": "..."}]}'
    )


def analyze_drift(
    drifted: list[dict],
    plan_output: str,
    llm: Optional[LlmFn] = None,
) -> dict[str, Any]:
    """Return {"analyses": [...]} or, on any failure, {"analyses": [],
    "unavailable": True}. Never raises."""
    if not drifted:
        return {"analyses": []}
    call = llm or _default_llm
    try:
        raw = call(_build_prompt(drifted, plan_output))
        parsed = json.loads(raw)
        analyses = parsed.get("analyses")
        if not isinstance(analyses, list):
            return {"analyses": [], "unavailable": True}
        return {"analyses": analyses}
    except Exception:  # noqa: BLE001 — drift must render without AI
        return {"analyses": [], "unavailable": True}


def _default_llm(prompt: str) -> str:
    """Runtime LLM call. The sidecar's real LLM layer is streaming
    (`ccie_sidecar.agent.chat_stream`); wiring that here is deferred. Until then
    this raises so `analyze_drift` degrades to an `unavailable` result rather
    than silently fabricating analysis. The RPC handler may pass an explicit
    `llm` to enable real analysis."""
    raise NotImplementedError(
        "real LLM drift analysis not yet wired; pass an explicit `llm` callable"
    )
