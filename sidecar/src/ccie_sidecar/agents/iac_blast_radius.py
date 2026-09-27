"""IaC blast-radius classification (Phase 2).

Single source of truth for blast-radius thresholds. Lives in Python because the
agent is the only Phase-2 consumer and the sidecar cannot call back into Rust
(the bridge is one-directional). Tiers use the standardized HITL vocabulary
``low | medium | high | destructive`` (critical == destructive) so the existing
deepagents gating (`tier_for_tool`/`should_interrupt`) reuses them unchanged.

Thresholds mirror the design spec (§2):
  destroy>0 AND production            -> destructive (critical)
  total>50 OR destroy>10              -> destructive (critical)
  total>20 OR destroy>0               -> high
  total>5  OR production              -> medium
  else                                -> low
"""
from __future__ import annotations

import json
import os
import subprocess
from typing import Tuple

# Standardized tier vocabulary (matches deepagents_hitl.BLAST_RADIUS_TIERS).
TIER_LOW = "low"
TIER_MEDIUM = "medium"
TIER_HIGH = "high"
TIER_DESTRUCTIVE = "destructive"  # spec's "critical"

_PRODUCTION_KEYWORDS = ("prod", "production")
_PRODUCTION_BRANCHES = ("main", "master")


def detect_production_environment(working_dir: str, git_branch: str) -> bool:
    """Heuristic production detection: dir name keyword, main/master branch, or
    a .terraform/environment file mentioning prod."""
    dir_name = os.path.basename(os.path.normpath(working_dir or "")).lower()
    if any(kw in dir_name for kw in _PRODUCTION_KEYWORDS):
        return True
    if (git_branch or "").strip().lower() in _PRODUCTION_BRANCHES:
        return True
    try:
        env_file = os.path.join(working_dir, ".terraform", "environment")
        with open(env_file, "r", encoding="utf-8") as fh:
            if any(kw in fh.read().lower() for kw in _PRODUCTION_KEYWORDS):
                return True
    except OSError:
        pass
    return False


def classify_terraform(
    create: int,
    update: int,
    destroy: int,
    working_dir: str,
    git_branch: str,
) -> str:
    """Classify a terraform change set into a blast-radius tier."""
    total = create + update + destroy
    is_prod = detect_production_environment(working_dir, git_branch)

    if destroy > 0 and is_prod:
        return TIER_DESTRUCTIVE
    if total > 50 or destroy > 10:
        return TIER_DESTRUCTIVE
    if total > 20 or destroy > 0:
        return TIER_HIGH
    if total > 5 or is_prod:
        return TIER_MEDIUM
    return TIER_LOW


def classify_ansible(is_production: bool, has_destructive_tag: bool) -> str:
    """Classify an ansible run. Ansible has no plan, so risk is driven by
    production target and whether the playbook carries a destructive tag."""
    if has_destructive_tag:
        return TIER_DESTRUCTIVE if is_production else TIER_HIGH
    return TIER_HIGH if is_production else TIER_MEDIUM


def count_actions(plan_json: str) -> Tuple[int, int, int]:
    """Count (create, update, destroy) from `terraform plan -json` output.

    Prefers a ``change_summary`` line (add/change/remove totals) when present;
    otherwise counts individual ``planned_change`` events. Malformed/empty input
    yields (0, 0, 0) — callers fail safe to a high tier on no data.
    """
    create = update = destroy = 0
    summary: Tuple[int, int, int] | None = None
    for line in (plan_json or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except (ValueError, TypeError):
            continue
        if not isinstance(obj, dict):
            continue
        ev_type = obj.get("type")
        if ev_type == "change_summary":
            changes = obj.get("changes") or {}
            summary = (
                int(changes.get("add", 0) or 0),
                int(changes.get("change", 0) or 0),
                int(changes.get("remove", 0) or 0),
            )
        elif ev_type in ("planned_change", "resource_drift", "apply_complete"):
            change = obj.get("change") or {}
            # terraform uses either a single "action" or an "actions" list
            action = change.get("action")
            actions = change.get("actions") or ([action] if action else [])
            for a in actions:
                if a == "create":
                    create += 1
                elif a == "update":
                    update += 1
                elif a in ("delete", "destroy"):
                    destroy += 1
    if summary is not None:
        return summary
    return (create, update, destroy)


def run_terraform_plan_json(working_dir: str, timeout: int = 120) -> str:
    """Run ``terraform plan -json`` (read-only) and return raw stdout.

    Raises on missing terraform or a plan error (exit 1) so callers can fall
    back to parsing prior output. Exit 0 (no changes) and 2 (changes present)
    are both success.
    """
    result = subprocess.run(
        ["terraform", "plan", "-json", "-no-color"],
        cwd=working_dir,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    if result.returncode not in (0, 2):
        raise RuntimeError(
            f"terraform plan failed (exit {result.returncode}): {result.stderr.strip()}"
        )
    return result.stdout


def classify_iac(
    tool: str,
    working_dir: str,
    git_branch: str,
    plan_output: str | None = None,
    is_production: bool | None = None,
    has_destructive_tag: bool = False,
) -> dict:
    """High-level entry point used by the agent tool and the RPC method.

    For terraform: prefer a fresh ``terraform plan -json``; fall back to
    ``plan_output`` if provided; if neither yields data, FAIL SAFE to "high".
    For ansible: classify from production + destructive-tag flags.

    Returns a dict: {tier, create, update, destroy, source, note?}.
    """
    if tool == "ansible":
        prod = (
            is_production
            if is_production is not None
            else detect_production_environment(working_dir, git_branch)
        )
        return {
            "tier": classify_ansible(prod, has_destructive_tag),
            "create": 0,
            "update": 0,
            "destroy": 0,
            "source": "ansible-flags",
        }

    # terraform
    raw = None
    source = None
    try:
        raw = run_terraform_plan_json(working_dir)
        source = "fresh-plan"
    except Exception:  # noqa: BLE001 — fall back to provided output
        if plan_output:
            raw = plan_output
            source = "parsed-output"

    if raw is None:
        # No plan data at all -> unknown risk -> gate.
        return {
            "tier": TIER_HIGH,
            "create": 0,
            "update": 0,
            "destroy": 0,
            "source": "fail-safe",
            "note": "no plan data available; defaulting to high so the operation is gated",
        }

    create, update, destroy = count_actions(raw)
    tier = classify_terraform(create, update, destroy, working_dir, git_branch)
    return {
        "tier": tier,
        "create": create,
        "update": update,
        "destroy": destroy,
        "source": source,
    }
