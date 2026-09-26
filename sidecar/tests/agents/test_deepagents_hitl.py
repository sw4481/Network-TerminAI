"""Unit tests for deepagents_hitl.py — approval gating (Seam 3)."""
import pytest

from ccie_sidecar.agents.deepagents_hitl import (
    tier_for_tool,
    classify_code_blast_radius,
    is_tier_allowed,
    should_interrupt,
    build_approval_request,
)


# Blast radius classification tests
def test_classify_code_destructive():
    """Test that destructive code is classified correctly."""
    code = "import os\nos.remove('/important/file.txt')"
    assert classify_code_blast_radius(code) == "destructive"

    code = "import shutil\nshutil.rmtree('/data')"
    assert classify_code_blast_radius(code) == "destructive"

    code = "import subprocess\nsubprocess.run('rm -rf /', shell=True)"
    assert classify_code_blast_radius(code) == "destructive"

    code = "cursor.execute('DROP TABLE users')"
    assert classify_code_blast_radius(code) == "destructive"


def test_classify_code_high():
    """Test that high-risk code is classified correctly."""
    code = "with open('config.txt', 'w') as f:\n    f.write('data')"
    assert classify_code_blast_radius(code) == "high"

    code = "import requests\nrequests.post('https://api.example.com/create')"
    assert classify_code_blast_radius(code) == "high"

    code = "cursor.execute('UPDATE users SET admin=1')"
    assert classify_code_blast_radius(code) == "high"


def test_classify_code_medium():
    """Test that medium-risk code is classified correctly."""
    code = "with open('data.txt', 'r') as f:\n    content = f.read()"
    assert classify_code_blast_radius(code) == "medium"

    code = "import requests\nrequests.get('https://api.example.com/data')"
    assert classify_code_blast_radius(code) == "medium"

    code = "cursor.execute('SELECT * FROM users')"
    assert classify_code_blast_radius(code) == "medium"


def test_classify_code_low():
    """Test that low-risk code is classified correctly."""
    code = "x = 5 + 3\nprint(x)"
    assert classify_code_blast_radius(code) == "low"

    code = "import pandas as pd\ndf = pd.DataFrame({'a': [1, 2, 3]})\nprint(df.mean())"
    assert classify_code_blast_radius(code) == "low"

    code = "result = sum([1, 2, 3, 4, 5])"
    assert classify_code_blast_radius(code) == "low"


# Tool tier determination tests
def test_tier_for_tool_from_metadata():
    """Test that tool tier is extracted from metadata."""
    tier = tier_for_tool(
        tool_name="meraki_networks_update",
        tool_args={},
        tool_metadata={"blast_radius": "high"},
    )
    assert tier == "high"


def test_tier_for_tool_execute_python_code():
    """Test that execute_python_code tier is determined by code content."""
    tier = tier_for_tool(
        tool_name="execute_python_code",
        tool_args={"code": "os.remove('file.txt')"},
        tool_metadata={},
    )
    assert tier == "destructive"

    tier = tier_for_tool(
        tool_name="execute_python_code",
        tool_args={"code": "print('hello')"},
        tool_metadata={},
    )
    assert tier == "low"


def test_tier_for_tool_planning_tools():
    """Test that planning tools are always low risk."""
    for tool_name in ["write_todos", "read_todos", "update_todo", "delete_todo"]:
        tier = tier_for_tool(tool_name, {}, {})
        assert tier == "low"


def test_tier_for_tool_unknown_defaults_medium():
    """Test that unknown tools default to medium."""
    tier = tier_for_tool("unknown_tool", {}, {})
    assert tier == "medium"


# Tier allowance tests
@pytest.mark.parametrize(
    "tier,default_allowed,expected",
    [
        ("low", "low", True),
        ("low", "medium", True),
        ("low", "high", True),
        ("low", "destructive", True),
        ("medium", "low", False),
        ("medium", "medium", True),
        ("medium", "high", True),
        ("medium", "destructive", True),
        ("high", "low", False),
        ("high", "medium", False),
        ("high", "high", True),
        ("high", "destructive", True),
        ("destructive", "low", False),
        ("destructive", "medium", False),
        ("destructive", "high", False),
        ("destructive", "destructive", True),
    ],
)
def test_is_tier_allowed(tier, default_allowed, expected):
    """Test tier allowance truth table."""
    assert is_tier_allowed(tier, default_allowed) == expected


def test_should_interrupt():
    """Test that should_interrupt is inverse of is_tier_allowed."""
    # Should interrupt high when default is medium
    assert should_interrupt("high", "medium") is True

    # Should NOT interrupt low when default is medium
    assert should_interrupt("low", "medium") is False

    # Should NOT interrupt medium when default is medium
    assert should_interrupt("medium", "medium") is False


# Approval request building tests
def test_build_approval_request():
    """Test approval request event structure."""
    event = build_approval_request(
        tool_name="meraki_networks_delete",
        tool_args={"network_id": "N_123"},
        blast_radius="destructive",
    )

    assert event["type"] == "tool_approval_request"
    assert event["tool_name"] == "meraki_networks_delete"
    assert event["tool_args"] == {"network_id": "N_123"}
    assert event["blast_radius"] == "destructive"


# Edge cases
def test_classify_code_case_insensitive():
    """Test that code classification is case-insensitive."""
    code = "IMPORT OS\nOS.REMOVE('file.txt')"
    assert classify_code_blast_radius(code) == "destructive"


def test_classify_code_with_comments():
    """Test that comments don't affect classification."""
    code = """
    # This is safe code
    x = 5 + 3
    print(x)
    """
    assert classify_code_blast_radius(code) == "low"


def test_classify_code_false_positive_in_string():
    """Test that code in strings doesn't trigger classification."""
    # This is tricky - the regex will still match
    # Real implementation might need more sophisticated parsing
    code = "message = 'Do not os.remove this file'\nprint(message)"
    # Current implementation will classify as destructive (expected limitation)
    assert classify_code_blast_radius(code) == "destructive"


def test_tier_for_tool_with_empty_code():
    """Test that empty code defaults to low."""
    tier = tier_for_tool(
        tool_name="execute_python_code",
        tool_args={"code": ""},
        tool_metadata={},
    )
    assert tier == "low"


def test_unknown_tier_not_allowed():
    """Test that unknown tiers default to not allowed."""
    assert is_tier_allowed("unknown_tier", "medium") is False
    assert should_interrupt("unknown_tier", "medium") is True


# IaC Phase 2: the gated iac_apply tool must always require approval.
def test_iac_apply_tool_is_gated():
    """The iac_apply tool is tagged destructive and must interrupt under any
    sane default-allowed setting."""
    from ccie_sidecar.agents.iac_tools import build_iac_apply_tool

    tool = build_iac_apply_tool(apply_runner=lambda *a, **k: (0, "", ""))
    tier = tier_for_tool(
        tool_name=tool.name,
        tool_args={"working_dir": "/infra/prod", "command": "terraform apply"},
        tool_metadata=tool.metadata,
    )
    assert tier == "destructive"
    assert should_interrupt(tier, "low") is True
    assert should_interrupt(tier, "medium") is True
    assert should_interrupt(tier, "high") is True
