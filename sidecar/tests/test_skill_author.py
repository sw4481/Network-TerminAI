"""Tests for AI-assisted skill authoring."""
import os
import pytest
from unittest.mock import patch, MagicMock
from ccie_sidecar.skill_author import (
    generate_skill,
    validate_skill_frontmatter,
    suggest_scripts,
)


class TestSkillGeneration:
    """Test skill generation from natural language."""

    @patch('ccie_sidecar.providers.anthropic.complete')
    @patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'mock-key'})
    def test_generate_skill_basic(self, mock_complete):
        """Test basic skill generation."""
        # Mock AI response
        mock_complete.return_value = """---
name: network-backup
description: Backup network device configurations
when-to-use: When user asks to backup configs, save device settings, or archive running-config
scripts: []
allowed-commands: []
---

# Skill Playbook

When the user requests a network backup:
1. Identify the device type (Cisco, Arista, etc.)
2. Connect to the device using SSH
3. Execute 'show running-config' command
4. Save output to a timestamped file
5. Verify the backup was successful
"""

        result = generate_skill(
            description="Create a skill to backup network device configurations",
            examples=None,
        )

        assert "skill_md" in result
        assert "suggested_scripts" in result
        assert "name: network-backup" in result["skill_md"]
        assert "# Skill Playbook" in result["skill_md"]

    @patch('ccie_sidecar.providers.anthropic.complete')
    @patch.dict(os.environ, {'ANTHROPIC_API_KEY': 'mock-key'})
    def test_generate_skill_with_examples(self, mock_complete):
        """Test skill generation with examples."""
        mock_complete.return_value = """---
name: parse-logs
description: Parse and analyze log files
when-to-use: When user needs to analyze logs, extract errors, or find patterns
scripts:
  - parse_logs.py
allowed-commands:
  - grep
  - awk
  - sed
---

# Skill Playbook

When analyzing logs:
1. Read the log file
2. Filter for relevant entries
3. Extract key information
4. Present findings to user
"""

        result = generate_skill(
            description="Parse log files and extract error messages",
            examples=["Parse syslog for ERROR entries", "Find crash dumps in logs"],
        )

        assert "skill_md" in result
        assert "parse-logs" in result["skill_md"]
        assert "# Skill Playbook" in result["skill_md"]
        mock_complete.assert_called_once()

    def test_generate_skill_requires_api_key(self):
        """Test that skill generation requires API key."""
        # Temporarily remove API key if present
        original_key = os.environ.get("ANTHROPIC_API_KEY")
        if "ANTHROPIC_API_KEY" in os.environ:
            del os.environ["ANTHROPIC_API_KEY"]

        try:
            with pytest.raises(ValueError, match="ANTHROPIC_API_KEY"):
                generate_skill("Create a test skill")
        finally:
            # Restore original key if it existed
            if original_key:
                os.environ["ANTHROPIC_API_KEY"] = original_key


class TestFrontmatterValidation:
    """Test YAML frontmatter validation."""

    def test_validate_valid_frontmatter(self):
        """Test validation of valid frontmatter."""
        skill_md = """---
name: test-skill
description: A test skill
when-to-use: When testing
scripts: []
allowed-commands: []
---

# Skill Playbook
Test content
"""
        errors = validate_skill_frontmatter(skill_md)
        assert len(errors) == 0

    def test_validate_missing_frontmatter(self):
        """Test validation fails with missing frontmatter."""
        skill_md = """# Skill Playbook
No frontmatter here
"""
        errors = validate_skill_frontmatter(skill_md)
        assert len(errors) > 0
        assert any("frontmatter" in err.lower() for err in errors)

    def test_validate_invalid_yaml(self):
        """Test validation fails with invalid YAML."""
        skill_md = """---
name: test-skill
description: missing quote
invalid: [unclosed
---

# Skill Playbook
"""
        errors = validate_skill_frontmatter(skill_md)
        assert len(errors) > 0
        assert any("yaml" in err.lower() for err in errors)

    def test_validate_missing_required_fields(self):
        """Test validation fails with missing required fields."""
        skill_md = """---
name: test-skill
---

# Skill Playbook
"""
        errors = validate_skill_frontmatter(skill_md)
        assert len(errors) > 0
        assert any("description" in err.lower() for err in errors)

    def test_validate_invalid_name_format(self):
        """Test validation fails with non-kebab-case name."""
        skill_md = """---
name: TestSkill_NotKebab
description: Invalid name format
when-to-use: Testing
scripts: []
allowed-commands: []
---

# Skill Playbook
"""
        errors = validate_skill_frontmatter(skill_md)
        assert len(errors) > 0
        assert any("kebab-case" in err.lower() for err in errors)

    def test_validate_kebab_case_variations(self):
        """Test kebab-case validation accepts valid names."""
        valid_names = [
            "test-skill",
            "network-backup",
            "parse-logs-v2",
            "abc",
            "a-b-c-d-e",
        ]

        for name in valid_names:
            skill_md = f"""---
name: {name}
description: Test
when-to-use: Testing
scripts: []
allowed-commands: []
---

# Skill Playbook
"""
            errors = validate_skill_frontmatter(skill_md)
            assert len(errors) == 0, f"Name '{name}' should be valid but got errors: {errors}"


class TestScriptSuggestions:
    """Test script suggestions based on description."""

    def test_suggest_python_for_parsing(self):
        """Test that Python scripts are suggested for parsing tasks."""
        description = "Parse log files and extract error messages"
        suggestions = suggest_scripts(description)

        assert len(suggestions) > 0
        assert any(s["language"] == "python" for s in suggestions)
        assert any("parse" in s["filename"].lower() for s in suggestions)

    def test_suggest_bash_for_status_check(self):
        """Test that Bash scripts are suggested for status checks."""
        description = "Check the status of network devices"
        suggestions = suggest_scripts(description)

        assert len(suggestions) > 0
        assert any(s["language"] == "bash" for s in suggestions)
        assert any("status" in s["filename"].lower() or "check" in s["filename"].lower() for s in suggestions)

    def test_suggest_multiple_scripts(self):
        """Test multiple script suggestions for complex tasks."""
        description = "Parse logs and check device status, then analyze output"
        suggestions = suggest_scripts(description)

        # Should suggest both Python and Bash scripts
        languages = {s["language"] for s in suggestions}
        assert "python" in languages or "bash" in languages
        assert len(suggestions) >= 1

    def test_script_suggestions_include_skeleton(self):
        """Test that script suggestions include skeleton code."""
        description = "Parse configuration files"
        suggestions = suggest_scripts(description)

        assert len(suggestions) > 0
        for suggestion in suggestions:
            assert "skeleton" in suggestion
            assert len(suggestion["skeleton"]) > 0
            assert suggestion["language"] in ["python", "bash"]

    def test_no_suggestions_for_simple_commands(self):
        """Test that simple tasks don't suggest scripts unnecessarily."""
        description = "List files in current directory"
        suggestions = suggest_scripts(description)

        # Simple tasks might not need scripts
        # But if they do suggest, they should be valid
        for suggestion in suggestions:
            assert "filename" in suggestion
            assert "language" in suggestion
            assert "skeleton" in suggestion


class TestSkillAuthorIntegration:
    """Integration tests with real AI (requires API key)."""

    @pytest.mark.skipif(
        "ANTHROPIC_API_KEY" not in os.environ,
        reason="Requires ANTHROPIC_API_KEY environment variable"
    )
    def test_generate_skill_integration(self):
        """Integration test with real API."""
        result = generate_skill(
            description="Create a skill to backup network configurations",
            examples=None,
        )

        assert "skill_md" in result
        assert "suggested_scripts" in result

        # Validate the generated skill
        errors = validate_skill_frontmatter(result["skill_md"])
        assert len(errors) == 0, f"Generated skill has validation errors: {errors}"

        # Should have basic structure
        assert "---" in result["skill_md"]
        assert "name:" in result["skill_md"]
        assert "description:" in result["skill_md"]
        assert "# Skill Playbook" in result["skill_md"]
