"""Tests for the troubleshoot YAML schema + loader.

Spec coverage:
- A minimal-but-realistic playbook loads and round-trips its fields.
- Schema violations (missing required field, empty steps, bad id pattern)
  raise ValidationError.
- Cross-reference errors (branch.next, on_pass, on_fail pointing at a
  missing step id) raise ValidationError.
- Per-type required-field omissions raise ValidationError.
- Duplicate step ids are rejected.
"""

from __future__ import annotations

import pytest

from ccie_sidecar.troubleshoot.yaml_loader import ValidationError, load_playbook


def test_valid_playbook_loads() -> None:
    yaml_text = """
id: bgp-wont-peer
name: BGP session will not peer
symptom_keywords: [bgp, peer, neighbor]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: command
    command: show bgp neighbor {{neighbor}}
  - id: s2
    type: branch
    expression: "vrf.default.neighbor[0].session_state"
    cases:
      - when: "Idle (Admin)"
        next: s3_admin_down
      - when: "Active"
        next: s3_tcp_check
  - id: s3_admin_down
    type: narration
    text: "neighbor admin shut"
  - id: s3_tcp_check
    type: command
    command: show tcp brief
"""
    pb = load_playbook(yaml_text)
    assert pb["id"] == "bgp-wont-peer"
    assert pb["vendor"] == "cisco"
    assert pb["platform"] == "iosxe"
    assert len(pb["steps"]) == 4


def test_invalid_playbook_rejected_missing_fields() -> None:
    """Missing required top-level fields -> schema error."""
    with pytest.raises(ValidationError, match="schema errors"):
        load_playbook("id: bad\nname: x\nsteps: []")


def test_empty_steps_rejected() -> None:
    yaml_text = """
id: empty
name: Empty
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps: []
"""
    with pytest.raises(ValidationError, match="schema errors"):
        load_playbook(yaml_text)


def test_bad_id_pattern_rejected() -> None:
    yaml_text = """
id: BadID_With_Underscores
name: x
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: narration
    text: hi
"""
    with pytest.raises(ValidationError, match="schema errors"):
        load_playbook(yaml_text)


def test_unknown_step_type_rejected() -> None:
    yaml_text = """
id: bad-step
name: x
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: bogus
"""
    with pytest.raises(ValidationError, match="schema errors"):
        load_playbook(yaml_text)


def test_branch_next_to_missing_step_rejected() -> None:
    yaml_text = """
id: dangling
name: x
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: branch
    expression: foo
    cases:
      - when: A
        next: does_not_exist
"""
    with pytest.raises(ValidationError, match="missing id 'does_not_exist'"):
        load_playbook(yaml_text)


def test_on_pass_to_missing_step_rejected() -> None:
    yaml_text = """
id: dangling-onpass
name: x
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: command
    command: show version
    on_pass: ghost
"""
    with pytest.raises(ValidationError, match="on_pass -> missing id 'ghost'"):
        load_playbook(yaml_text)


def test_on_fail_to_missing_step_rejected() -> None:
    yaml_text = """
id: dangling-onfail
name: x
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: command
    command: show version
    on_fail: ghost
"""
    with pytest.raises(ValidationError, match="on_fail -> missing id 'ghost'"):
        load_playbook(yaml_text)


def test_duplicate_step_ids_rejected() -> None:
    yaml_text = """
id: dup-ids
name: x
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: narration
    text: a
  - id: s1
    type: narration
    text: b
"""
    with pytest.raises(ValidationError, match="duplicate step id"):
        load_playbook(yaml_text)


def test_command_step_without_command_rejected() -> None:
    yaml_text = """
id: missing-command
name: x
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: command
"""
    with pytest.raises(ValidationError, match=r"\(command\) missing 'command'"):
        load_playbook(yaml_text)


def test_branch_step_without_cases_rejected() -> None:
    yaml_text = """
id: missing-cases
name: x
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: branch
    expression: foo
"""
    with pytest.raises(ValidationError, match=r"\(branch\) missing 'cases'"):
        load_playbook(yaml_text)


def test_narration_without_text_rejected() -> None:
    yaml_text = """
id: missing-text
name: x
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: narration
"""
    with pytest.raises(ValidationError, match=r"\(narration\) missing 'text'"):
        load_playbook(yaml_text)


def test_user_prompt_without_prompt_rejected() -> None:
    yaml_text = """
id: missing-prompt
name: x
symptom_keywords: [x]
vendor: cisco
platform: iosxe
steps:
  - id: s1
    type: user_prompt
"""
    with pytest.raises(ValidationError, match=r"\(user_prompt\) missing 'prompt'"):
        load_playbook(yaml_text)


def test_yaml_parse_error_wrapped() -> None:
    with pytest.raises(ValidationError, match="yaml parse error"):
        load_playbook("id: [unclosed\n")


def test_root_not_a_mapping_rejected() -> None:
    with pytest.raises(ValidationError, match="must be a mapping"):
        load_playbook("- item1\n- item2\n")
