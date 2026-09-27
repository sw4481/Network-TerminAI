"""Tests for blast-radius classifier."""

import pytest
from terminai_pyats.blast_radius import compute_blast_radius


def test_compute_returns_catalog_tier_for_low_verbs():
    """Low-tier verbs return 'low'."""
    assert compute_blast_radius("list-devices", {}) == "low"
    assert compute_blast_radius("run-show-command", {"command": "show version"}) == "low"


def test_compute_returns_catalog_tier_for_medium_verbs():
    """Medium-tier verbs return 'medium'."""
    assert compute_blast_radius("run-linux-command", {"command": "ls"}) == "medium"


def test_compute_returns_catalog_tier_for_high_verbs():
    """High-tier verbs return 'high'."""
    assert compute_blast_radius("configure", {"config": "interface Gi0/0"}) == "high"
    assert compute_blast_radius("rollback-config", {}) == "high"


def test_compute_escalates_high_to_destructive_with_keywords():
    """High-tier verbs escalate to destructive if config has destructive keywords."""
    assert compute_blast_radius("configure", {"config": "reload in 5"}) == "destructive"
    assert compute_blast_radius("configure", {"config": "write erase"}) == "destructive"
    assert compute_blast_radius("configure-multi", {"config": "format flash:"}) == "destructive"


def test_compute_keeps_high_for_safe_config():
    """High-tier verbs stay high if config is safe."""
    assert compute_blast_radius("configure", {"config": "hostname CORE1"}) == "high"
    assert compute_blast_radius("configure-with-diff", {"config": "description test"}) == "high"


def test_compute_run_pyats_code_defaults_to_low():
    """run-pyats-code with no destructive keywords returns low."""
    code = "result = testbed.devices['CORE1'].parse('show version')"
    assert compute_blast_radius("run-pyats-code", {"code": code}) == "low"


def test_compute_run_pyats_code_escalates_for_config():
    """run-pyats-code escalates if code contains .configure()."""
    code = "testbed.devices['CORE1'].configure('hostname TEST')"
    assert compute_blast_radius("run-pyats-code", {"code": code}) == "high"


def test_compute_run_pyats_code_escalates_to_destructive():
    """run-pyats-code escalates to destructive if code has destructive keywords."""
    code = "testbed.devices['CORE1'].configure('reload in 5')"
    assert compute_blast_radius("run-pyats-code", {"code": code}) == "destructive"


def test_compute_returns_low_for_unknown_verb():
    """Unknown verbs default to low (defensive)."""
    assert compute_blast_radius("unknown-verb", {}) == "low"
