"""Tests for the IaC blast-radius classifier (Phase 2, Task 1).

Single source of truth for blast-radius thresholds lives in Python (the agent
is the only Phase-2 consumer; the sidecar cannot call back into Rust). Tiers use
the standardized vocabulary low|medium|high|destructive (critical -> destructive)
so the existing deepagents HITL gating reuses them.
"""
from __future__ import annotations

from ccie_sidecar.agents.iac_blast_radius import (
    classify_terraform,
    classify_ansible,
    detect_production_environment,
    count_actions,
)


class TestProductionDetection:
    def test_main_branch_is_production(self):
        assert detect_production_environment("/infra/whatever", "main") is True
        assert detect_production_environment("/infra/whatever", "master") is True

    def test_prod_dir_name_is_production(self):
        assert detect_production_environment("/infra/prod", "feature/x") is True
        assert detect_production_environment("/infra/production-east", "dev") is True

    def test_dev_is_not_production(self):
        assert detect_production_environment("/infra/dev", "feature/x") is False
        assert detect_production_environment("/infra/staging", "develop") is False


class TestTerraformClassification:
    def test_destroy_in_production_is_destructive(self):
        # critical maps to "destructive" in the tier vocabulary
        assert classify_terraform(2, 0, 1, "/infra/prod", "main") == "destructive"

    def test_large_change_is_destructive(self):
        assert classify_terraform(60, 0, 0, "/infra/dev", "feature/x") == "destructive"

    def test_many_destroys_is_destructive(self):
        assert classify_terraform(0, 0, 11, "/infra/dev", "feature/x") == "destructive"

    def test_over_20_is_high(self):
        assert classify_terraform(25, 0, 0, "/infra/dev", "feature/x") == "high"

    def test_destroy_in_nonprod_is_high(self):
        # >0 destroy but not prod, small total -> still elevated to high
        assert classify_terraform(1, 0, 2, "/infra/dev", "feature/x") == "high"

    def test_over_5_is_medium(self):
        assert classify_terraform(6, 0, 0, "/infra/dev", "feature/x") == "medium"

    def test_production_small_change_is_medium(self):
        assert classify_terraform(1, 0, 0, "/infra/prod", "feature/x") == "medium"

    def test_small_dev_change_is_low(self):
        assert classify_terraform(2, 1, 0, "/infra/dev", "feature/x") == "low"


class TestAnsibleClassification:
    def test_destructive_tag_in_prod_is_destructive(self):
        assert classify_ansible(is_production=True, has_destructive_tag=True) == "destructive"

    def test_destructive_tag_nonprod_is_high(self):
        assert classify_ansible(is_production=False, has_destructive_tag=True) == "high"

    def test_production_no_tag_is_high(self):
        assert classify_ansible(is_production=True, has_destructive_tag=False) == "high"

    def test_nonprod_no_tag_is_medium(self):
        assert classify_ansible(is_production=False, has_destructive_tag=False) == "medium"


class TestCountActions:
    def test_counts_from_terraform_plan_json(self):
        # `terraform plan -json` emits one "resource_drift"/"planned_change" line
        # per change with a change.action / change.actions field.
        plan = "\n".join([
            '{"type":"planned_change","change":{"resource":{"addr":"aws_s3_bucket.a"},"action":"create"}}',
            '{"type":"planned_change","change":{"resource":{"addr":"aws_s3_bucket.b"},"action":"update"}}',
            '{"type":"planned_change","change":{"resource":{"addr":"aws_s3_bucket.c"},"action":"delete"}}',
            '{"type":"change_summary","changes":{"add":1,"change":1,"remove":1}}',
        ])
        create, update, destroy = count_actions(plan)
        assert (create, update, destroy) == (1, 1, 1)

    def test_prefers_change_summary_when_present(self):
        # If a change_summary line exists, trust its add/change/remove totals.
        plan = '{"type":"change_summary","changes":{"add":3,"change":2,"remove":4}}'
        assert count_actions(plan) == (3, 2, 4)

    def test_empty_plan_is_zero(self):
        assert count_actions("") == (0, 0, 0)
        assert count_actions("not json\n{bad}") == (0, 0, 0)
