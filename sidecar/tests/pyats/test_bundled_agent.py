"""Tests for pyATS bundled agent."""

import json
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
AGENT_DIR = os.path.join(ROOT, "bundled-agents", "pyats")


def test_agent_md_has_required_frontmatter():
    """AGENT.md should have required frontmatter fields."""
    text = open(os.path.join(AGENT_DIR, "AGENT.md"), encoding="utf-8").read()
    assert "name: pyats" in text
    assert "execution-mode: react-code" in text
    assert "attached-tools:" in text
    assert "id: pyats" in text


def test_tools_json_has_15_verbs():
    """tools.json should have all 15 verbs."""
    tools = json.load(open(os.path.join(AGENT_DIR, "tools.json"), encoding="utf-8"))
    assert len(tools) == 15
    assert any(t["name"] == "run-show-command" for t in tools)
    assert any(t["name"] == "configure" for t in tools)
