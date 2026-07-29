"""Plan 15 Phase 3 — narrator tests.

These tests run offline. They monkeypatch ``narrator._invoke_llm`` so no
live LLM is contacted, and they verify the structural / keyword
contracts the Rust caller depends on.

Coverage:
  * narrate produces ``{"text", "citations"}``.
  * Three sample traces (BGP idle-admin, OSPF init, errdisable) → the
    narration mentions the right keyword, including "no shutdown" for
    BGP idle-admin.
  * conclude produces all four required fields.
  * conclude defaults are sane when the LLM returns garbage.
  * Missing RAG client does not break narration.
  * conclude redacts sensitive fields before sending to the LLM.
"""

from __future__ import annotations

import json
import sys
from typing import Any

import pytest

from ccie_sidecar.troubleshoot import narrator


# ---------------------------------------------------------------------------
# Fixture LLM helpers — drive deterministic responses keyed off the prompt.
# ---------------------------------------------------------------------------


class _LLMRecorder:
    """Captures every prompt the code under test passes to the LLM
    helper, then returns a canned response based on a routing function.
    """

    def __init__(self, route):
        self.prompts: list[str] = []
        self.route = route

    def __call__(
        self,
        prompt: str,
        max_tokens: int = 160,
        temperature: float = 0.1,
    ) -> str:
        self.prompts.append(prompt)
        return self.route(prompt)


def _bgp_idle_route(prompt: str) -> str:
    if "Idle (Admin)" in prompt or "narrate_admin" in prompt:
        return (
            "Neighbor 10.0.0.5 is administratively shut. "
            "Run 'no shutdown' under the BGP neighbor config to recover."
        )
    return "BGP step explanation."


def _ospf_init_route(prompt: str) -> str:
    if "Init" in prompt or "ospf" in prompt.lower():
        return (
            "OSPF neighbor stuck in Init: hello packets received but no "
            "two-way adjacency. Likely an MTU or area-id mismatch."
        )
    return "OSPF step."


def _errdisable_route(prompt: str) -> str:
    if "err-disabled" in prompt.lower() or "errdisable" in prompt.lower():
        return (
            "Interface is err-disabled by bpduguard. "
            "Run 'errdisable recovery cause bpduguard' to auto-recover."
        )
    return "Interface step."


# ---------------------------------------------------------------------------
# narrate() tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_narrate_bgp_idle_admin_says_no_shutdown(monkeypatch):
    rec = _LLMRecorder(_bgp_idle_route)
    monkeypatch.setattr(narrator, "_invoke_llm", rec)

    step = {
        "id": "narrate_admin",
        "type": "narration",
        "text": "Neighbor administratively shut.",
    }
    parsed = {"vrf": {"default": {"neighbor": [{"session_state": "Idle (Admin)"}]}}}
    result = await narrator.narrate(
        step, parsed, {"neighbor": "10.0.0.5"}, "cisco", "iosxe"
    )

    assert isinstance(result, dict)
    assert "text" in result and "citations" in result
    assert isinstance(result["text"], str)
    assert "no shutdown" in result["text"].lower()
    assert "10.0.0.5" in result["text"] or "administratively" in result["text"].lower()
    assert isinstance(result["citations"], list)
    # The prompt the LLM saw should mention the parsed state so the
    # downstream prompt template hasn't drifted.
    assert any("Idle (Admin)" in p for p in rec.prompts)


@pytest.mark.asyncio
async def test_narrate_ospf_neighbor_init(monkeypatch):
    rec = _LLMRecorder(_ospf_init_route)
    monkeypatch.setattr(narrator, "_invoke_llm", rec)

    step = {
        "id": "check_state",
        "type": "command",
        "command": "show ip ospf neighbor",
    }
    parsed = {"interfaces": [{"neighbor_id": "1.1.1.1", "state": "Init"}]}
    result = await narrator.narrate(step, parsed, {}, "cisco", "iosxe")

    assert "init" in result["text"].lower()
    # Should at least hint at one of the common OSPF init causes.
    text = result["text"].lower()
    assert any(k in text for k in ("mtu", "area", "two-way", "two way", "hello"))


@pytest.mark.asyncio
async def test_narrate_errdisable_interface(monkeypatch):
    rec = _LLMRecorder(_errdisable_route)
    monkeypatch.setattr(narrator, "_invoke_llm", rec)

    step = {
        "id": "check_intf",
        "type": "command",
        "command": "show interface status err-disabled",
    }
    parsed = {"interfaces": [{"port": "Gi1/0/1", "reason": "bpduguard"}]}
    result = await narrator.narrate(step, parsed, {}, "cisco", "iosxe")

    assert "err-disabled" in result["text"].lower() or "errdisable" in result["text"].lower()
    assert "bpduguard" in result["text"].lower()


@pytest.mark.asyncio
async def test_narrate_handles_missing_rag_client(monkeypatch):
    """If `ccie_sidecar.rag.client.search` is unimportable, narrate
    must still succeed and return citations=[]. We force the import path
    to fail by injecting a sentinel that raises on attribute access.
    """
    # Ensure the module import path is genuinely broken: insert a
    # stand-in module that has no `search` attribute.
    class _Bomb:
        def __getattr__(self, name):
            raise ImportError("rag client unavailable")

    monkeypatch.setitem(sys.modules, "ccie_sidecar.rag.client", _Bomb())
    rec = _LLMRecorder(lambda _p: "BGP looks fine.")
    monkeypatch.setattr(narrator, "_invoke_llm", rec)

    step = {"id": "x", "type": "command", "command": "show bgp summary"}
    result = await narrator.narrate(step, {"summary": []}, {}, "cisco", "iosxe")

    assert result["citations"] == []
    assert isinstance(result["text"], str)
    assert result["text"]  # non-empty since LLM mock returned text


@pytest.mark.asyncio
async def test_narrate_empty_when_llm_unavailable(monkeypatch):
    """If `_invoke_llm` raises, narrate returns an empty text rather
    than blowing up the engine.
    """
    def boom(*_a, **_kw):
        raise RuntimeError("provider down")

    monkeypatch.setattr(narrator, "_invoke_llm", boom)

    step = {"id": "x", "type": "narration", "text": "fallback"}
    result = await narrator.narrate(step, None, {}, "cisco", "iosxe")
    assert result == {"text": "", "citations": []}


# ---------------------------------------------------------------------------
# conclude() tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_conclude_returns_four_fields(monkeypatch):
    canned = json.dumps(
        {
            "root_cause": "BGP neighbor 10.0.0.5 is administratively shut.",
            "confidence": "high",
            "suggested_fix": (
                "Enter the BGP neighbor config and issue 'no shutdown'."
            ),
            "evidence": [
                "session_state was 'Idle (Admin)'",
                "no TCP attempt on port 179",
            ],
        }
    )
    monkeypatch.setattr(narrator, "_invoke_llm", lambda *_a, **_kw: canned)

    history = [
        {
            "step_id": "check_state",
            "step_type": "command",
            "status": "passed",
            "result_json": {
                "vrf": {
                    "default": {"neighbor": [{"session_state": "Idle (Admin)"}]}
                }
            },
        },
        {
            "step_id": "narrate_admin",
            "step_type": "narration",
            "status": "passed",
            "result_json": {"text": "..."},
        },
    ]
    result = await narrator.conclude(
        history, "BGP won't peer", "cisco", "iosxe"
    )

    assert set(result.keys()) == {"root_cause", "confidence", "suggested_fix", "evidence"}
    assert result["confidence"] in ("low", "medium", "high")
    assert result["confidence"] == "high"
    assert "10.0.0.5" in result["root_cause"]
    assert "no shutdown" in result["suggested_fix"].lower()
    assert isinstance(result["evidence"], list)
    assert len(result["evidence"]) == 2


@pytest.mark.asyncio
async def test_conclude_handles_garbage_llm(monkeypatch):
    """If the LLM returns non-JSON, conclude still produces all four
    fields with sensible defaults."""
    monkeypatch.setattr(narrator, "_invoke_llm", lambda *_a, **_kw: "this is not JSON at all")

    result = await narrator.conclude([], "OSPF flaps", "cisco", "iosxe")

    assert set(result.keys()) == {"root_cause", "confidence", "suggested_fix", "evidence"}
    assert result["confidence"] == "low"
    assert "OSPF flaps" in result["root_cause"]
    assert isinstance(result["evidence"], list)
    assert isinstance(result["suggested_fix"], str)


@pytest.mark.asyncio
async def test_conclude_strips_markdown_fences(monkeypatch):
    fenced = "```json\n" + json.dumps(
        {
            "root_cause": "x",
            "confidence": "medium",
            "suggested_fix": "y",
            "evidence": ["a"],
        }
    ) + "\n```"
    monkeypatch.setattr(narrator, "_invoke_llm", lambda *_a, **_kw: fenced)

    result = await narrator.conclude([], "test", "cisco", "iosxe")
    assert result["confidence"] == "medium"
    assert result["root_cause"] == "x"


@pytest.mark.asyncio
async def test_conclude_clamps_invalid_confidence(monkeypatch):
    canned = json.dumps(
        {
            "root_cause": "x",
            "confidence": "ABSOLUTELY",
            "suggested_fix": "y",
            "evidence": [],
        }
    )
    monkeypatch.setattr(narrator, "_invoke_llm", lambda *_a, **_kw: canned)
    result = await narrator.conclude([], "test", "cisco", "iosxe")
    assert result["confidence"] == "low"


@pytest.mark.asyncio
async def test_conclude_redacts_sensitive_history(monkeypatch):
    """Sensitive vars/results must NOT reach the LLM verbatim."""
    captured: list[str] = []

    def capture(prompt: str, **_kw: Any) -> str:
        captured.append(prompt)
        return json.dumps(
            {
                "root_cause": "x",
                "confidence": "low",
                "suggested_fix": "y",
                "evidence": [],
            }
        )

    monkeypatch.setattr(narrator, "_invoke_llm", capture)

    history = [
        {
            "step_id": "creds",
            "step_type": "command",
            "status": "passed",
            "result_json": {
                "user": "admin",
                "password": "hunter2",
                "snmp": {"community": "secretrostring"},
            },
        }
    ]
    await narrator.conclude(history, "test", "cisco", "iosxe")

    assert captured, "LLM must have been called"
    rendered = captured[0]
    assert "hunter2" not in rendered
    assert "secretrostring" not in rendered
    assert "<redacted>" in rendered


@pytest.mark.asyncio
async def test_conclude_handles_llm_exception(monkeypatch):
    def boom(*_a, **_kw):
        raise RuntimeError("provider down")

    monkeypatch.setattr(narrator, "_invoke_llm", boom)
    result = await narrator.conclude([], "anything", "cisco", "iosxe")
    assert set(result.keys()) == {"root_cause", "confidence", "suggested_fix", "evidence"}
    assert result["confidence"] == "low"
