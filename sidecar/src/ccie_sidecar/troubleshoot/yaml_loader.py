"""YAML schema validator + loader for troubleshooting playbooks.

Two layers of validation run on every load:

1. **JSON Schema** — structural validation against ``schema.json`` using
   the Draft 2020-12 validator. Missing required fields, wrong types, or
   unknown step ``type`` values fail here.

2. **Cross-reference check** — every ``cases[].next``, ``on_pass`` and
   ``on_fail`` must resolve to a step ``id`` declared in the same file.
   This is *load-bearing* for safety: a playbook that branches into a
   missing step would silently dead-end at runtime, which for a network
   diagnostic engine could mean we stop investigating just before the
   step that would have caught the real fault.

Both layers raise :class:`ValidationError` with a human-readable message;
the caller (Rust seed loader, Tauri ``upsert_playbook`` command, Monaco
editor in Phase 6) is expected to surface the message verbatim.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml
from jsonschema import Draft202012Validator


class ValidationError(Exception):
    """Raised when a playbook YAML fails schema or cross-reference checks."""


_SCHEMA_PATH = Path(__file__).parent / "schema.json"
_SCHEMA: dict[str, Any] = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
_VALIDATOR = Draft202012Validator(_SCHEMA)


def load_playbook(yaml_text: str) -> dict[str, Any]:
    """Parse + validate a playbook YAML document.

    Args:
        yaml_text: Raw YAML source.

    Returns:
        The parsed document as a dict, ready to hand to the Rust engine.

    Raises:
        ValidationError: on YAML parse error, schema violation, or unresolved
            cross-reference.
    """
    try:
        doc = yaml.safe_load(yaml_text)
    except yaml.YAMLError as e:
        raise ValidationError(f"yaml parse error: {e}") from e

    if not isinstance(doc, dict):
        raise ValidationError(
            f"playbook root must be a mapping, got {type(doc).__name__}"
        )

    errors = sorted(_VALIDATOR.iter_errors(doc), key=lambda e: list(e.absolute_path))
    if errors:
        msgs = [
            f"{list(e.absolute_path) or '<root>'}: {e.message}" for e in errors
        ]
        raise ValidationError("schema errors: " + "; ".join(msgs))

    _cross_check(doc)
    return doc


def _cross_check(doc: dict[str, Any]) -> None:
    """Verify every branch / on_pass / on_fail target exists as a step id.

    Also enforces that step ids are unique within the file — duplicates
    would let a branch silently land on whichever step the first iterator
    hit, which is a recipe for non-deterministic walks.
    """
    steps = doc["steps"]
    ids: list[str] = [s["id"] for s in steps]
    if len(ids) != len(set(ids)):
        # Find the first duplicate for a useful error message.
        seen: set[str] = set()
        for sid in ids:
            if sid in seen:
                raise ValidationError(f"duplicate step id: {sid}")
            seen.add(sid)
    id_set = set(ids)

    for s in steps:
        for case in s.get("cases", []) or []:
            target = case["next"]
            if target not in id_set:
                raise ValidationError(
                    f"step '{s['id']}' branches to missing id '{target}'"
                )
        for k in ("on_pass", "on_fail"):
            ref = s.get(k)
            if ref is not None and ref not in id_set:
                raise ValidationError(
                    f"step '{s['id']}'.{k} -> missing id '{ref}'"
                )

        # Per-type sanity checks beyond the JSON schema. The schema lets
        # any optional field appear on any step type (so authors can iterate
        # quickly), but at load time we still require the *required* field
        # for that specific type — otherwise a `command` step with no
        # `command:` would crash the engine instead of failing loudly here.
        stype = s["type"]
        if stype == "command" and not s.get("command"):
            raise ValidationError(f"step '{s['id']}' (command) missing 'command'")
        if stype == "assertion":
            if not s.get("expression"):
                raise ValidationError(
                    f"step '{s['id']}' (assertion) missing 'expression'"
                )
            if "expects" not in s:
                raise ValidationError(
                    f"step '{s['id']}' (assertion) missing 'expects'"
                )
        if stype == "branch":
            if not s.get("expression"):
                raise ValidationError(
                    f"step '{s['id']}' (branch) missing 'expression'"
                )
            if not s.get("cases"):
                raise ValidationError(f"step '{s['id']}' (branch) missing 'cases'")
        if stype == "narration" and not s.get("text"):
            raise ValidationError(f"step '{s['id']}' (narration) missing 'text'")
        if stype == "user_prompt" and not s.get("prompt"):
            raise ValidationError(
                f"step '{s['id']}' (user_prompt) missing 'prompt'"
            )
