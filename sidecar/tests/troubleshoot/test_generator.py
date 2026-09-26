"""Tests for AI playbook generation (ccie_sidecar.troubleshoot.generator).

Offline: monkeypatch ``generator._invoke_llm`` so no LLM is called. We
exercise fence-stripping, schema validation, the truncation→retry path,
and the empty/no-provider fallbacks.
"""

from __future__ import annotations

from ccie_sidecar.troubleshoot import generator


VALID_YAML = """id: dot1x-fail
name: Dot1x failure
symptom_keywords: [dot1x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: command
    command: "show authentication sessions interface {{interface}}"
  - id: s2
    type: narration
    text: "Check RADIUS reachability."
"""

# Truncated mid-string (unterminated quote) — the exact failure the user hit.
TRUNCATED_YAML = """id: dot1x-fail
name: Dot1x failure
symptom_keywords: [dot1x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: narration
    text: "802.1x is enabled and the port is authorized
"""


def test_generate_empty_symptom_returns_error(monkeypatch):
    monkeypatch.setattr(generator, "_invoke_llm", lambda *a, **k: VALID_YAML)
    out = generator.generate_playbook("", "cisco", "iosxe")
    assert out["yaml"] == ""
    assert out["error"]


def test_generate_valid_yaml_passes_through(monkeypatch):
    monkeypatch.setattr(generator, "_invoke_llm", lambda *a, **k: VALID_YAML)
    out = generator.generate_playbook("dot1x failing", "cisco", "iosxe")
    assert out["error"] is None
    assert "show authentication sessions" in out["yaml"]


def test_generate_strips_markdown_fences(monkeypatch):
    fenced = "```yaml\n" + VALID_YAML + "```"
    monkeypatch.setattr(generator, "_invoke_llm", lambda *a, **k: fenced)
    out = generator.generate_playbook("dot1x failing", "cisco", "iosxe")
    assert out["error"] is None
    assert out["yaml"].startswith("id: dot1x-fail")


def test_generate_retries_once_on_truncation_then_succeeds(monkeypatch):
    """First call returns truncated YAML; the retry returns valid YAML."""
    calls = {"n": 0}

    def fake(*_a, **_k):
        calls["n"] += 1
        return TRUNCATED_YAML if calls["n"] == 1 else VALID_YAML

    monkeypatch.setattr(generator, "_invoke_llm", fake)
    out = generator.generate_playbook("dot1x failing", "cisco", "iosxe")
    assert calls["n"] == 2  # retried exactly once
    assert out["error"] is None
    assert "show authentication sessions" in out["yaml"]


def test_generate_both_attempts_truncated_returns_actionable_error(monkeypatch):
    monkeypatch.setattr(generator, "_invoke_llm", lambda *a, **k: TRUNCATED_YAML)
    out = generator.generate_playbook("dot1x failing", "cisco", "iosxe")
    # Two attempts, both truncated → returns the last yaml + a clear error.
    assert out["yaml"]  # not silently empty
    assert out["error"]
    assert "again" in out["error"].lower() or "incomplete" in out["error"].lower()


def test_generate_empty_llm_output_returns_config_hint(monkeypatch):
    monkeypatch.setattr(generator, "_invoke_llm", lambda *a, **k: "")
    out = generator.generate_playbook("dot1x failing", "cisco", "iosxe")
    assert out["yaml"] == ""
    assert "provider" in out["error"].lower()


def test_validate_yaml_catches_unterminated_string():
    err = generator._validate_yaml(TRUNCATED_YAML)
    assert err is not None
    assert "did not parse" in err
