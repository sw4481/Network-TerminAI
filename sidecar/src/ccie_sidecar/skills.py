"""Skills loading and management for CCIE Terminal."""
from __future__ import annotations

import re
from pathlib import Path
from typing import Any

import yaml


def parse_skill_md(content: str) -> dict[str, Any]:
    """
    Parse a SKILL.md file with YAML frontmatter.

    Args:
        content: The full content of the SKILL.md file

    Returns:
        Dict with parsed frontmatter fields and playbook body

    Raises:
        ValueError: If frontmatter is missing or invalid
    """
    # Extract frontmatter using regex
    frontmatter_pattern = r'^---\s*\n(.*?)\n---\s*\n(.*)$'
    match = re.match(frontmatter_pattern, content, re.DOTALL)

    if not match:
        raise ValueError("No frontmatter found in SKILL.md")

    frontmatter_text = match.group(1)
    playbook_body = match.group(2).strip()

    # Parse YAML frontmatter
    try:
        frontmatter = yaml.safe_load(frontmatter_text)
    except yaml.YAMLError as e:
        raise ValueError(f"Invalid YAML in frontmatter: {e}")

    if not isinstance(frontmatter, dict):
        raise ValueError("Frontmatter must be a YAML dictionary")

    # Add playbook body to result
    result = dict(frontmatter)
    result["playbook"] = playbook_body

    return result


def load_skill(skill_path: Path) -> dict[str, Any]:
    """
    Load a skill from a directory.

    Args:
        skill_path: Path to the skill directory

    Returns:
        Dict with skill metadata, playbook, and script paths

    Raises:
        FileNotFoundError: If skill directory or SKILL.md doesn't exist
        ValueError: If SKILL.md is invalid
    """
    if not skill_path.exists():
        raise FileNotFoundError(f"Skill directory not found: {skill_path}")

    skill_md_path = skill_path / "SKILL.md"
    if not skill_md_path.exists():
        raise FileNotFoundError(f"SKILL.md not found in {skill_path}")

    # Parse the SKILL.md file
    content = skill_md_path.read_text()
    skill = parse_skill_md(content)

    # Find scripts in the directory
    scripts = {}
    script_files = skill.get("scripts", [])
    for script_name in script_files:
        script_path = skill_path / script_name
        if script_path.exists():
            scripts[script_name] = str(script_path.absolute())

    skill["scripts"] = scripts
    skill["path"] = str(skill_path.absolute())

    return skill


def scan_skills_directory(skills_dir: Path) -> list[dict[str, Any]]:
    """
    Scan a directory for skills.

    Args:
        skills_dir: Path to the skills directory

    Returns:
        List of skill dictionaries
    """
    if not skills_dir.exists():
        return []

    skills = []
    for item in skills_dir.iterdir():
        if item.is_dir():
            skill_md = item / "SKILL.md"
            if skill_md.exists():
                try:
                    skill = load_skill(item)
                    skills.append(skill)
                except (FileNotFoundError, ValueError) as e:
                    # Skip invalid skills
                    print(f"Warning: Failed to load skill from {item}: {e}")
                    continue

    return skills


def get_skills_directory() -> Path:
    """
    Get the skills directory path.

    Returns:
        Path to the skills directory (e.g., ~/.ccie-terminal/skills)
    """
    import os
    home = Path.home()
    return home / ".ccie-terminal" / "skills"


def load_all_skills() -> dict[str, dict[str, Any]]:
    """
    Load all skills from the skills directory.

    Returns:
        Dict mapping skill names to skill data
    """
    skills_dir = get_skills_directory()
    skills_list = scan_skills_directory(skills_dir)

    # Index by name
    skills_by_name = {}
    for skill in skills_list:
        name = skill.get("name")
        if name:
            skills_by_name[name] = skill

    return skills_by_name


def get_skill(skill_name: str) -> dict[str, Any] | None:
    """
    Get a skill by name.

    Args:
        skill_name: The name of the skill

    Returns:
        Skill dict or None if not found
    """
    skills = load_all_skills()
    return skills.get(skill_name)


# ==================== PHASE 5: Skill Matching and Execution ====================


def match_skill(user_query: str, max_results: int = 3) -> list[dict[str, Any]]:
    """
    Match user query against available skills using AI or heuristic matching.

    Args:
        user_query: The user's query or request
        max_results: Maximum number of matches to return (default: 3)

    Returns:
        List of dicts with keys: skill_name, confidence (0-1), reason
        Sorted by confidence descending
    """
    all_skills = load_all_skills()

    if not all_skills:
        return []

    try:
        # Try AI matching first
        matches = _ai_match_skills(user_query, all_skills)
    except Exception as e:
        # Fall back to heuristic matching
        print(f"AI matching failed, using heuristic: {e}")
        matches = _heuristic_match_skills(user_query, all_skills)

    # Sort by confidence descending and limit results
    matches.sort(key=lambda m: m["confidence"], reverse=True)
    return matches[:max_results]


def _ai_match_skills(user_query: str, all_skills: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Use AI to match user query against skill when-to-use descriptions.

    Args:
        user_query: The user's query
        all_skills: Dict of skill_name -> skill_data

    Returns:
        List of matches with skill_name, confidence, and reason
    """
    import json
    import os
    from ccie_sidecar.providers.anthropic import complete

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY not set")

    # Build prompt with skill descriptions
    skills_desc = []
    for name, skill in all_skills.items():
        when_to_use = skill.get("when-to-use", skill.get("description", ""))
        skills_desc.append(f"- {name}: {when_to_use}")

    skills_list_str = "\n".join(skills_desc)

    prompt = f"""You are a skill matching assistant. Given a user query, match it against available skills.

Available skills:
{skills_list_str}

User query: {user_query}

Return a JSON array of matches with this structure:
{{"matches": [{{"skill_name": "skill-name", "confidence": 0.0-1.0, "reason": "why it matches"}}]}}

Only include skills with confidence >= 0.3. Sort by confidence descending.
Return empty array if no good matches."""

    response = complete(
        api_key=api_key,
        model="claude-haiku-4-5",
        messages=[{"role": "user", "content": prompt}],
        max_tokens=1024,
    )

    # Parse JSON response
    try:
        # Extract JSON from response (handle markdown code blocks)
        response_text = response.strip()
        if "```json" in response_text:
            start = response_text.find("```json") + 7
            end = response_text.find("```", start)
            response_text = response_text[start:end].strip()
        elif "```" in response_text:
            start = response_text.find("```") + 3
            end = response_text.find("```", start)
            response_text = response_text[start:end].strip()

        result = json.loads(response_text)
        matches = result.get("matches", [])

        # Validate structure
        validated_matches = []
        for match in matches:
            if "skill_name" in match and "confidence" in match:
                validated_matches.append({
                    "skill_name": match["skill_name"],
                    "confidence": float(match["confidence"]),
                    "reason": match.get("reason", ""),
                })

        return validated_matches

    except (json.JSONDecodeError, ValueError) as e:
        print(f"Failed to parse AI response: {e}")
        return []


def _heuristic_match_skills(user_query: str, all_skills: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """
    Use heuristic keyword matching to match query against skills.

    Args:
        user_query: The user's query
        all_skills: Dict of skill_name -> skill_data

    Returns:
        List of matches with skill_name, confidence, and reason
    """
    import re

    query_lower = user_query.lower()
    query_words = set(re.findall(r'\w+', query_lower))

    matches = []

    for name, skill in all_skills.items():
        # Get when-to-use text or description
        when_to_use = skill.get("when-to-use", skill.get("description", "")).lower()

        # Extract words from when-to-use
        skill_words = set(re.findall(r'\w+', when_to_use))

        # Calculate overlap
        common_words = query_words & skill_words
        if not skill_words:
            continue

        # Confidence based on Jaccard similarity
        jaccard = len(common_words) / len(query_words | skill_words)

        # Boost if skill name appears in query
        if name.replace("-", " ").lower() in query_lower:
            jaccard = min(1.0, jaccard + 0.3)

        if jaccard > 0.1:  # Threshold for relevance
            matches.append({
                "skill_name": name,
                "confidence": round(jaccard, 2),
                "reason": f"Keyword match: {', '.join(sorted(common_words)[:5])}" if common_words else "Name match",
            })

    return matches


def execute_skill_script(
    skill_name: str,
    script_name: str,
    args: list[str] | None = None,
    timeout: int = 30,
) -> dict[str, Any]:
    """
    Execute a skill's helper script.

    Args:
        skill_name: Name of the skill
        script_name: Name of the script to execute
        args: Optional list of command-line arguments
        timeout: Timeout in seconds (default: 30)

    Returns:
        Dict with keys: stdout, stderr, exit_code
    """
    import subprocess

    args = args or []

    # Load the skill
    skill = get_skill(skill_name)
    if not skill:
        return {
            "stdout": "",
            "stderr": f"Error: Skill '{skill_name}' not found",
            "exit_code": -1,
        }

    # Check if script is in allowed scripts list
    allowed_scripts = skill.get("scripts", {})
    if script_name not in allowed_scripts:
        return {
            "stdout": "",
            "stderr": f"Error: Script '{script_name}' not in allowed scripts for skill '{skill_name}'",
            "exit_code": -1,
        }

    # Get script path
    script_path = allowed_scripts[script_name]

    # Get skill directory for cwd
    skill_dir = Path(skill["path"])

    try:
        # Execute the script
        result = subprocess.run(
            [script_path] + args,
            cwd=str(skill_dir),
            capture_output=True,
            text=True,
            timeout=timeout,
        )

        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "exit_code": result.returncode,
        }

    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": f"Error: Script '{script_name}' timed out after {timeout} seconds",
            "exit_code": -1,
        }
    except Exception as e:
        return {
            "stdout": "",
            "stderr": f"Error executing script: {str(e)}",
            "exit_code": -1,
        }
