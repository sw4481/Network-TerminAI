"""Tests for multi-turn history threading into agent loops.

Regression: every agent turn was stateless — the sidecar built a brand-new
one-message conversation, so the agent forgot context from prior turns (e.g.
re-asking which policy to change after the user already said so). History is
now forwarded from the frontend via ctx["history"].
"""
from __future__ import annotations

import pytest
from langchain_core.messages import AIMessage, HumanMessage

from ccie_sidecar.agents.code_exec import build_history_messages
from ccie_sidecar.agents.deepagents_runtime import _build_input_messages
from ccie_sidecar.agents import graph_autocapture


SAMPLE_CTX = {
    "history": [
        {"role": "user", "content": "list the switch access policies"},
        {"role": "assistant", "content": "Here are the 7 policies..."},
        {"role": "user", "content": ""},  # empty streaming shell — must be dropped
        {"role": "tool_result", "content": "ignored"},  # non-chat role — dropped
    ]
}


@pytest.fixture(autouse=True)
def isolate_context_graph_recall(monkeypatch):
    """History tests must not read facts from the developer's sessions.db."""
    monkeypatch.setattr(graph_autocapture, "recall_context_message", lambda _msg: "")


class TestLegacyHistory:
    def test_prepends_history_then_new_turn(self):
        msgs = build_history_messages(SAMPLE_CTX, "change MAB-Only to multi-host")
        assert msgs == [
            {"role": "user", "content": "list the switch access policies"},
            {"role": "assistant", "content": "Here are the 7 policies..."},
            {"role": "user", "content": "change MAB-Only to multi-host"},
        ]

    def test_empty_ctx_falls_back_to_single_message(self):
        assert build_history_messages({}, "hi") == [{"role": "user", "content": "hi"}]
        assert build_history_messages(None, "hi") == [{"role": "user", "content": "hi"}]

    def test_drops_blank_and_non_chat_roles(self):
        ctx = {"history": [
            {"role": "user", "content": "  "},
            {"role": "tool_proposed", "content": "x"},
            {"role": "assistant", "content": "real"},
        ]}
        msgs = build_history_messages(ctx, "now")
        assert msgs == [
            {"role": "assistant", "content": "real"},
            {"role": "user", "content": "now"},
        ]

    def test_recall_is_merged_into_current_user_turn(self, monkeypatch):
        monkeypatch.setattr(
            graph_autocapture,
            "recall_context_message",
            lambda _msg: "ESTABLISHED CONTEXT:\n  meraki:network:example-branch",
        )

        msgs = build_history_messages({}, "list the access policies")

        assert msgs == [{
            "role": "user",
            "content": (
                "ESTABLISHED CONTEXT:\n  meraki:network:example-branch\n\n"
                "CURRENT REQUEST (answer this now):\n"
                "list the access policies"
            ),
        }]
        assert not any(message["role"] == "assistant" for message in msgs)


class TestDeepAgentsHistory:
    def test_maps_roles_to_langchain_messages(self):
        msgs = _build_input_messages(SAMPLE_CTX, "change MAB-Only to multi-host")
        assert [type(m).__name__ for m in msgs] == [
            "HumanMessage",
            "AIMessage",
            "HumanMessage",
        ]
        assert isinstance(msgs[0], HumanMessage)
        assert isinstance(msgs[1], AIMessage)
        assert msgs[1].id == "history-assistant-1"
        assert msgs[-1].content == "change MAB-Only to multi-host"

    def test_empty_ctx_single_human_message(self):
        msgs = _build_input_messages(None, "hi")
        assert len(msgs) == 1
        assert isinstance(msgs[0], HumanMessage)
        assert msgs[0].content == "hi"

    def test_recall_is_not_injected_as_a_synthetic_assistant(self, monkeypatch):
        monkeypatch.setattr(
            graph_autocapture,
            "recall_context_message",
            lambda _msg: "ESTABLISHED CONTEXT:\n  meraki:network:example-branch",
        )

        msgs = _build_input_messages({}, "list the access policies")

        assert len(msgs) == 1
        assert isinstance(msgs[0], HumanMessage)
        assert msgs[0].content == (
            "ESTABLISHED CONTEXT:\n  meraki:network:example-branch\n\n"
            "CURRENT REQUEST (answer this now):\n"
            "list the access policies"
        )
