"""Tests for explain_api_response — the 'make JSON human-readable' helper
used by the API tab's ✨ Explain button.

The function uses the provider configured in Settings (via
`get_saved_config()`) and falls back to `ANTHROPIC_API_KEY` only when
no config is saved.
"""
import os

import pytest
from unittest.mock import patch

from ccie_sidecar.agent import explain_api_response


def test_explain_requires_some_provider_when_nothing_configured():
    # No saved config, no env var → clear "go to Settings" message.
    with patch.dict(os.environ, {}, clear=True):
        with patch(
            "ccie_sidecar.agent.get_saved_config", return_value=None
        ):
            with pytest.raises(ValueError, match="Settings"):
                explain_api_response(
                    method="GET",
                    url="https://api.meraki.com/api/v1/organizations",
                    status_code=200,
                    body="[]",
                )


def test_explain_uses_saved_provider_over_env_var():
    """The saved (Settings) config must win over ANTHROPIC_API_KEY. We
    assert that when both are present, `openai.stream_chat` is called,
    not `anthropic.stream_chat`."""
    saved = {
        "provider": "openai",
        "model": "gpt-4o-mini",
        "api_key": "sk-saved",
        "base_url": None,
    }
    calls: list[str] = []

    def fake_openai(**kwargs):
        calls.append("openai")
        yield {"type": "token", "data": "You have 2 orgs."}

    def fake_anthropic(**kwargs):  # pragma: no cover - shouldn't fire
        calls.append("anthropic")
        yield {"type": "token", "data": "WRONG"}

    with patch.dict(
        os.environ, {"ANTHROPIC_API_KEY": "sk-env"}, clear=False
    ):
        with patch(
            "ccie_sidecar.agent.get_saved_config", return_value=saved
        ), patch(
            "ccie_sidecar.agent.openai.stream_chat", side_effect=fake_openai
        ), patch(
            "ccie_sidecar.agent.anthropic.stream_chat", side_effect=fake_anthropic
        ):
            out = explain_api_response(
                method="GET",
                url="https://x",
                status_code=200,
                body="[]",
            )
    assert calls == ["openai"], f"expected openai, got {calls}"
    assert "You have 2 orgs." in out


def test_explain_concatenates_stream_tokens():
    """The function wraps a streaming provider — it must concatenate
    every `token` event into a single string. Previously it only called
    the sync `complete()` on Anthropic, which left Google/Ollama users
    with no plain-English summary path."""
    saved = {"provider": "anthropic", "model": "claude-sonnet-4-6",
             "api_key": "sk-x", "base_url": None}

    def fake_stream(**kwargs):
        yield {"type": "token", "data": "You have "}
        yield {"type": "token", "data": "12 orgs."}
        yield {"type": "done"}

    with patch("ccie_sidecar.agent.get_saved_config", return_value=saved):
        with patch(
            "ccie_sidecar.agent.anthropic.stream_chat",
            side_effect=fake_stream,
        ):
            out = explain_api_response(
                method="GET",
                url="https://x",
                status_code=200,
                body='{"n":12}',
            )
    assert out == "You have 12 orgs."


def test_explain_surfaces_provider_errors_as_value_error():
    """Provider stream yielding `{type: error}` must become a ValueError
    so the Tauri layer can render it in the UI's red banner."""
    saved = {"provider": "anthropic", "model": "m", "api_key": "k", "base_url": None}

    def fake_stream(**kwargs):
        yield {"type": "error", "message": "rate limit"}

    with patch("ccie_sidecar.agent.get_saved_config", return_value=saved):
        with patch(
            "ccie_sidecar.agent.anthropic.stream_chat",
            side_effect=fake_stream,
        ):
            with pytest.raises(ValueError, match="rate limit"):
                explain_api_response(
                    method="GET", url="https://x", status_code=200, body="[]"
                )


def test_explain_truncates_huge_bodies_before_the_model_call():
    """The 32 KB cap must apply BEFORE the model call — otherwise we'd
    blow the context window on a 5 MB device dump. We confirm the cap
    by asserting the prompt passed to stream_chat is < 40 KB."""
    big_body = "x" * 40_000
    saved = {"provider": "anthropic", "model": "m", "api_key": "k", "base_url": None}
    captured = {}

    def fake_stream(**kwargs):
        captured["messages"] = kwargs.get("messages", [])
        yield {"type": "token", "data": "ok"}

    with patch("ccie_sidecar.agent.get_saved_config", return_value=saved):
        with patch(
            "ccie_sidecar.agent.anthropic.stream_chat",
            side_effect=fake_stream,
        ):
            explain_api_response(
                method="GET", url="https://x", status_code=200, body=big_body
            )
    # Prompt should carry at most ~34 KB (32 KB body + markers + headers).
    prompt_text = captured["messages"][0]["content"]
    assert len(prompt_text) < 36_000, f"prompt too large: {len(prompt_text)}"
    assert "truncated" in prompt_text


@pytest.mark.skipif(
    "ANTHROPIC_API_KEY" not in os.environ,
    reason="Requires ANTHROPIC_API_KEY environment variable",
)
def test_explain_api_response_integration():
    summary = explain_api_response(
        method="GET",
        url="https://api.meraki.com/api/v1/organizations",
        status_code=200,
        body='[{"id":"L_1","name":"Acme HQ"},{"id":"L_2","name":"Acme Lab"}]',
    )
    assert isinstance(summary, str)
    assert len(summary) > 0
    # A plausible summary of two orgs mentions either "2" or "two".
    lc = summary.lower()
    assert (
        "organization" in lc
        or "orgs" in lc
        or "acme" in lc
    ), f"summary doesn't look plausible: {summary!r}"
