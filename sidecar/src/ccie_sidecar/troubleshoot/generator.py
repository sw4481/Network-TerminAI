"""AI playbook generation for the troubleshoot editor.

Wired into the NDJSON server as `troubleshoot.generate_playbook`. Given a
free-form symptom description (plus optional vendor/platform), asks the
user-configured LLM to author a complete, schema-valid playbook YAML.

Design mirrors `narrator.py`:
- Uses the SAME provider/model/key the chat panel uses (read from the
  app's SQLite ``ai_config`` table via ``agent.get_saved_config()``).
- Returns a structured dict ``{"yaml": str, "error": str | None}``. The
  caller (Rust → editor) drops the YAML straight into the Monaco buffer
  where the existing client-side validator gates Save.
- The generated YAML is validated against the bundled JSON schema here so
  we never hand the editor something that fails to parse; on validation
  failure we still return the raw text plus a warning so the operator can
  fix it by hand rather than losing the generation.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

# Reuse the narrator's provider-aware LLM invocation so generation honours
# the user's configured provider (NVIDIA / Ollama / vLLM / OpenAI / etc.),
# not a hardcoded Anthropic key.
from ccie_sidecar.troubleshoot.narrator import _invoke_llm

_SCHEMA_PATH = Path(__file__).parent / "schema.json"


_SYSTEM_GUIDANCE = """\
You are a senior network engineer authoring a troubleshooting playbook for \
the CCIE Terminal. Produce a SINGLE YAML document and NOTHING else (no \
markdown fences, no prose before or after).

The playbook MUST conform to this contract:
- Top-level keys: id, name, symptom_keywords, vendor, platform, description, steps
- id: lowercase slug, [a-z0-9-] only
- symptom_keywords: list of lowercase words a user might type for this symptom
- steps: ordered list. Each step has an `id` and a `type`. Valid types:
    - command:    runs a read-only "show" command. Field: command.
                  ONLY use non-destructive Tier-0 show/display commands.
                  NEVER emit config, clear, reload, debug, or write commands.
    - branch:     routes on a JSONPath-ish expression over the previous
                  parsed output. Fields: expression, cases (list of {when, next}).
    - assertion:  Fields: expression, expects, on_pass, on_fail.
    - narration:  explains findings / suggests a fix. Field: text.
                  Remediation must be described as narration, NOT executed.
    - user_prompt: asks the operator a question. Field: prompt.
- Use {{variable}} placeholders for values the operator supplies
  (e.g. {{neighbor}}, {{interface}}). The operator fills these in BEFORE the
  run starts — they are collected from the UI's "Required variables" panel.
- IMPORTANT: do NOT use a `user_prompt` step to collect a value that you
  then reference with `{{...}}`. A user_prompt's answer is stored under a
  different key and will NOT resolve a `{{var}}` substitution, producing a
  broken playbook. If a step needs an interface/neighbor/etc., just use the
  `{{var}}` placeholder directly and OMIT any user_prompt for it. Reserve
  user_prompt only for free-form questions whose answer is NOT substituted
  into a later command (e.g. "Did the change resolve the issue? (yes/no)").
- Keep it focused: 3-8 steps. End reachable paths with a narration step
  that states the likely root cause and suggested fix.

LENGTH & FORMAT RULES (important — keep the output short and parseable):
- Every `text:` and `prompt:` value MUST be a SINGLE short line (max ~200
  chars). Do NOT use YAML block scalars (`|` or `>`), bullet lists, or
  newlines inside a value — they make the output long and easy to truncate.
- Always wrap `text:`/`prompt:`/`command:` values in double quotes and put
  the whole value on one line.
- Prefer 4-6 steps. Be concise.

Return ONLY the YAML.
"""


def _load_schema() -> dict[str, Any]:
    try:
        return json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _strip_fences(text: str) -> str:
    """Remove ```/```yaml fences if the model added them despite instructions."""
    t = text.strip()
    if t.startswith("```"):
        # drop first line (``` or ```yaml)
        t = t.split("\n", 1)[1] if "\n" in t else ""
        if t.rstrip().endswith("```"):
            t = t.rstrip()[:-3]
    return t.strip()


def _validate_yaml(yaml_text: str) -> str | None:
    """Return an error string if the YAML is invalid/non-conformant, else None."""
    try:
        import yaml as _yaml
    except Exception:
        return None  # PyYAML should be present; skip validation if not
    try:
        doc = _yaml.safe_load(yaml_text)
    except Exception as exc:
        return f"Generated YAML did not parse: {exc}"
    if not isinstance(doc, dict):
        return "Generated playbook is not a YAML mapping."
    schema = _load_schema()
    if not schema:
        return None
    try:
        from jsonschema import Draft202012Validator

        errors = sorted(
            Draft202012Validator(schema).iter_errors(doc),
            key=lambda e: list(e.path),
        )
        if errors:
            first = errors[0]
            loc = "/".join(str(p) for p in first.path) or "(root)"
            return f"Schema violation at {loc}: {first.message}"
    except Exception:
        # jsonschema missing or internal error — don't block the generation.
        return None
    return None


def generate_playbook(
    symptom: str,
    vendor: str | None,
    platform: str | None,
) -> dict[str, Any]:
    """Generate a playbook YAML for `symptom`.

    Returns ``{"yaml": str, "error": str | None}``. ``error`` is non-null
    when no LLM is configured or generation failed entirely (yaml empty),
    OR as a soft warning when the YAML was produced but failed validation
    (yaml still populated so the operator can fix it).
    """
    symptom = (symptom or "").strip()
    if not symptom:
        return {"yaml": "", "error": "Describe the symptom first."}

    vendor = (vendor or "cisco").strip() or "cisco"
    platform = (platform or "iosxe").strip() or "iosxe"

    base_prompt = (
        f"{_SYSTEM_GUIDANCE}\n\n"
        f"Target vendor: {vendor}\n"
        f"Target platform: {platform}\n"
        f"Symptom to diagnose: {symptom}\n\n"
        "Author the playbook YAML now."
    )

    # Two attempts: the second only runs if the first produced YAML that
    # didn't parse (commonly because a reasoning model ran long and
    # truncated mid-string). The retry adds an explicit "be shorter /
    # single-line values" nudge and a bigger token budget. We give the
    # operator a clean, parseable playbook or a clear error — never a
    # silently-broken half-document.
    last_yaml = ""
    last_parse_error: str | None = None
    for attempt in range(2):
        prompt = base_prompt
        if attempt == 1:
            prompt += (
                "\n\nYour previous output was not valid YAML (it was likely "
                "truncated). Produce a SHORTER playbook (4-6 steps), keep "
                "every text/prompt value on a single quoted line, and make "
                "sure the YAML is COMPLETE and parses cleanly."
            )
        # 8192: reasoning models (e.g. gpt-oss-120b) spend many tokens on
        # internal reasoning before the visible YAML; long multi-step
        # playbooks with narration need headroom or they truncate.
        try:
            raw = _invoke_llm(prompt, max_tokens=8192, temperature=0.2)
        except Exception as exc:
            return {"yaml": "", "error": f"LLM invocation failed: {exc}"}

        yaml_text = _strip_fences(raw or "")
        if not yaml_text:
            return {
                "yaml": "",
                "error": (
                    "No LLM is configured (Settings → AI) or the model "
                    "returned nothing. Configure a provider and try again."
                ),
            }

        parse_error = _validate_yaml(yaml_text)
        if parse_error is None:
            # Valid (or schema-only warning is None) — done.
            return {"yaml": yaml_text, "error": None}

        last_yaml = yaml_text
        last_parse_error = parse_error
        # Only retry for parse failures (truncation), not schema nits.
        if not parse_error.startswith("Generated YAML did not parse"):
            break

    # Both attempts failed to parse. Return the last attempt with a clear,
    # actionable error so the operator knows it needs a manual fix / retry
    # rather than silently accepting a broken document.
    return {
        "yaml": last_yaml,
        "error": (
            f"{last_parse_error}. The model's output was incomplete — "
            "try 'Generate with AI' again, or edit the YAML to close the "
            "unterminated value."
        ),
    }
