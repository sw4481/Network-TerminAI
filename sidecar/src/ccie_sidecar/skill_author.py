"""AI-assisted skill authoring for CCIE Terminal."""
from __future__ import annotations

import os
import re
from typing import Any

import yaml


def generate_skill(
    description: str,
    examples: list[str] | None = None,
    profile: str = "default",
) -> dict[str, Any]:
    """
    Generate a SKILL.md file from natural language description.

    Args:
        description: Natural language description of the skill
        examples: Optional list of example use cases
        profile: Model profile to use ("default", "quality", "budget")

    Returns:
        Dict with:
            - skill_md: The generated SKILL.md content
            - suggested_scripts: List of suggested scripts with skeleton code

    Raises:
        ValueError: If ANTHROPIC_API_KEY is not set
    """
    from ccie_sidecar.providers.anthropic import complete

    # Load API key from environment
    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY environment variable not set")

    # Map profile to model
    model_map = {
        "default": "claude-sonnet-4-6",
        "quality": "claude-opus-4-7",
        "budget": "claude-haiku-4-5",
    }
    model = model_map.get(profile, "claude-sonnet-4-6")

    # Build system prompt
    system_prompt = """You are a skill authoring assistant for a terminal application.
Generate a SKILL.md file from the user's description.

The SKILL.md format has YAML frontmatter followed by a detailed playbook:

---
name: skill-name
description: One-line description
when-to-use: Detailed trigger conditions describing when the AI should invoke this skill
scripts: []
allowed-commands: []
---

# Skill Playbook

[Detailed step-by-step instructions for the AI agent to follow when executing this skill.
Be specific about what to check, what commands to run, and how to handle errors.
Use numbered steps and clear language.]

Important rules:
1. The 'name' field must be kebab-case (lowercase with hyphens, e.g., 'network-backup')
2. The 'when-to-use' field should be detailed and specific to help the AI know when to trigger this skill
3. The playbook should be actionable and detailed
4. Include error handling and validation steps
5. Be concise but thorough

Output ONLY the SKILL.md content. Do not include explanations or commentary."""

    # Build user message
    user_message = f"Skill description: {description}"
    if examples:
        user_message += f"\n\nExample use cases:\n"
        for i, example in enumerate(examples, 1):
            user_message += f"{i}. {example}\n"

    # Get completion
    skill_md = complete(
        api_key=api_key,
        model=model,
        messages=[{"role": "user", "content": f"{system_prompt}\n\n{user_message}"}],
        max_tokens=2048,
    )

    # Clean up response - remove markdown code blocks if present
    skill_md = skill_md.strip()
    if skill_md.startswith("```"):
        lines = skill_md.split("\n")
        if lines[0].startswith("```") and lines[-1].strip() == "```":
            skill_md = "\n".join(lines[1:-1]).strip()

    # Generate script suggestions
    suggested_scripts = suggest_scripts(description)

    return {
        "skill_md": skill_md,
        "suggested_scripts": suggested_scripts,
    }


def validate_skill_frontmatter(skill_md: str) -> list[str]:
    """
    Validate the YAML frontmatter in a SKILL.md file.

    Args:
        skill_md: The SKILL.md content to validate

    Returns:
        List of validation error messages (empty if valid)
    """
    errors = []

    # Check for frontmatter delimiters
    if not skill_md.startswith("---"):
        errors.append("Missing frontmatter: file must start with '---'")
        return errors

    # Extract frontmatter
    parts = skill_md.split("---", 2)
    if len(parts) < 3:
        errors.append("Invalid frontmatter: missing closing '---'")
        return errors

    frontmatter_text = parts[1].strip()

    # Parse YAML
    try:
        frontmatter = yaml.safe_load(frontmatter_text)
    except yaml.YAMLError as e:
        errors.append(f"Invalid YAML in frontmatter: {e}")
        return errors

    if not isinstance(frontmatter, dict):
        errors.append("Frontmatter must be a YAML dictionary")
        return errors

    # Check required fields
    required_fields = ["name", "description", "when-to-use"]
    for field in required_fields:
        if field not in frontmatter:
            errors.append(f"Missing required field: '{field}'")

    # Validate name format (kebab-case)
    if "name" in frontmatter:
        name = frontmatter["name"]
        if not isinstance(name, str):
            errors.append("Field 'name' must be a string")
        elif not re.match(r"^[a-z][a-z0-9]*(-[a-z0-9]+)*$", name):
            errors.append(
                f"Field 'name' must be kebab-case (lowercase with hyphens): '{name}'"
            )

    # Validate other fields are present and correct type
    if "description" in frontmatter and not isinstance(frontmatter["description"], str):
        errors.append("Field 'description' must be a string")

    if "when-to-use" in frontmatter and not isinstance(frontmatter["when-to-use"], str):
        errors.append("Field 'when-to-use' must be a string")

    return errors


def suggest_scripts(description: str) -> list[dict[str, str]]:
    """
    Suggest scripts based on the skill description.

    Args:
        description: Natural language description of the skill

    Returns:
        List of script suggestions with:
            - filename: Suggested script filename
            - language: Script language (python, bash)
            - skeleton: Skeleton code for the script
    """
    suggestions = []
    description_lower = description.lower()

    # Suggest Python script for parsing/analysis tasks
    if any(keyword in description_lower for keyword in ["parse", "analyze", "extract", "process"]):
        filename = "parse_output.py" if "parse" in description_lower else "analyze.py"
        skeleton = """#!/usr/bin/env python3
\"\"\"Script to process and analyze data.\"\"\"
import sys
import argparse


def main():
    parser = argparse.ArgumentParser(description="Process data")
    parser.add_argument("input_file", help="Input file to process")
    parser.add_argument("--output", "-o", help="Output file (default: stdout)")
    args = parser.parse_args()

    # TODO: Implement processing logic
    with open(args.input_file, "r", encoding="utf-8") as f:
        data = f.read()

    # Process data here
    result = data  # Replace with actual processing

    if args.output:
        with open(args.output, "w") as f:
            f.write(result)
    else:
        print(result)


if __name__ == "__main__":
    main()
"""
        suggestions.append({
            "filename": filename,
            "language": "python",
            "skeleton": skeleton,
        })

    # Suggest Bash script for status/check tasks
    if any(keyword in description_lower for keyword in ["status", "check", "monitor", "verify"]):
        filename = "check_status.sh"
        skeleton = """#!/usr/bin/env bash
# Script to check status

set -euo pipefail

# Configuration
TARGET="${1:-localhost}"

# Color output
RED='\\033[0;31m'
GREEN='\\033[0;32m'
NC='\\033[0m' # No Color

# Function to check status
check_status() {
    echo "Checking status of $TARGET..."

    # TODO: Implement status check logic
    # Example: ping -c 1 "$TARGET" &> /dev/null

    if [ $? -eq 0 ]; then
        echo -e "${GREEN}Status: OK${NC}"
        return 0
    else
        echo -e "${RED}Status: FAILED${NC}"
        return 1
    fi
}

# Main
check_status
"""
        suggestions.append({
            "filename": filename,
            "language": "bash",
            "skeleton": skeleton,
        })

    # Suggest Python script for backup/save tasks
    if any(keyword in description_lower for keyword in ["backup", "save", "archive", "store"]):
        filename = "backup.py"
        skeleton = """#!/usr/bin/env python3
\"\"\"Script to backup data.\"\"\"
import sys
import os
from datetime import datetime
import argparse


def backup(source, destination):
    \"\"\"Backup source to destination with timestamp.\"\"\"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    backup_name = f"{os.path.basename(source)}_{timestamp}"
    backup_path = os.path.join(destination, backup_name)

    # TODO: Implement backup logic
    print(f"Backing up {source} to {backup_path}")

    return backup_path


def main():
    parser = argparse.ArgumentParser(description="Backup data")
    parser.add_argument("source", help="Source file or directory")
    parser.add_argument("--dest", "-d", default="./backups", help="Destination directory")
    args = parser.parse_args()

    os.makedirs(args.dest, exist_ok=True)
    backup_path = backup(args.source, args.dest)
    print(f"Backup completed: {backup_path}")


if __name__ == "__main__":
    main()
"""
        suggestions.append({
            "filename": filename,
            "language": "python",
            "skeleton": skeleton,
        })

    return suggestions
