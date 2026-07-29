"""Verify every shipped builtin troubleshooting playbook validates.

This test is deliberately strict. The builtin set is `include_str!`'d into
the Rust binary via `src-tauri/src/troubleshoot/seed.rs`; if any of these
seeds fails to validate at runtime the app would either fail to start or
expose unrunnable playbooks in the UI. We treat every assertion here as a
release blocker.

Coverage:
- Exactly six seeds ship (sentinel against accidental additions/removals).
- Every seed parses + validates against the JSON schema.
- Every seed has at least 4 steps including at least one `command`, one
  `branch` or `assertion`, and one `narration` step.
- Every seed targets Cisco IOS-XE for now (Phase 1 scope; future phases may
  add other vendors with their own validity tests).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from ccie_sidecar.troubleshoot.yaml_loader import load_playbook

SEEDS_DIR = (
    Path(__file__).resolve().parent.parent.parent
    / "src"
    / "ccie_sidecar"
    / "troubleshoot"
    / "seeds"
)

EXPECTED_SEEDS = {
    "bgp-wont-peer",
    "ospf-neighbor-init",
    "interface-err-disabled",
    "dhcp-no-lease",
    "ipsec-phase1-fail",
    "mac-flap",
}


def _seed_files() -> list[Path]:
    return sorted(SEEDS_DIR.glob("*.yaml"))


def test_seeds_dir_exists() -> None:
    assert SEEDS_DIR.is_dir(), f"missing seeds dir: {SEEDS_DIR}"


def test_exactly_six_seeds_ship() -> None:
    files = _seed_files()
    assert len(files) == 6, (
        f"expected 6 seeds, got {len(files)}: "
        f"{[f.name for f in files]}"
    )


def test_seed_ids_match_expected_set() -> None:
    ids = {f.stem for f in _seed_files()}
    assert ids == EXPECTED_SEEDS, f"unexpected seed set: {ids}"


@pytest.mark.parametrize(
    "seed_path", _seed_files(), ids=lambda p: p.name
)
def test_seed_validates(seed_path: Path) -> None:
    pb = load_playbook(seed_path.read_text(encoding="utf-8"))
    assert pb["id"] == seed_path.stem, (
        f"file name '{seed_path.name}' must match playbook id '{pb['id']}'"
    )
    assert pb["vendor"] == "cisco"
    assert pb["platform"] == "iosxe"


@pytest.mark.parametrize(
    "seed_path", _seed_files(), ids=lambda p: p.name
)
def test_seed_has_minimum_richness(seed_path: Path) -> None:
    """Each seed must include enough variety to actually be useful."""
    pb = load_playbook(seed_path.read_text(encoding="utf-8"))
    types = [s["type"] for s in pb["steps"]]
    assert len(pb["steps"]) >= 4, (
        f"{seed_path.name}: at least 4 steps required, got {len(pb['steps'])}"
    )
    assert "command" in types, f"{seed_path.name}: needs at least one command step"
    assert ("branch" in types) or ("assertion" in types), (
        f"{seed_path.name}: needs at least one branch or assertion step"
    )
    assert "narration" in types, f"{seed_path.name}: needs at least one narration"
