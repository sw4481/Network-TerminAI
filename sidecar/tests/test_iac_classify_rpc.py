"""Tests for the iac.classify_blast_radius RPC method (Phase 2, Task 5).

This RPC exposes the Python blast-radius classifier so the Rust/terminal side
can reuse the single source of truth. Uses plan_output so no real terraform
binary is needed (terraform-absent path falls back to the provided output).
"""
from __future__ import annotations

from ccie_sidecar.server import handle_request


def test_classify_requires_working_dir():
    resp = handle_request({
        "id": "r1",
        "method": "iac.classify_blast_radius",
        "params": {"tool": "terraform"},
    })
    assert resp["type"] == "error"
    assert "working_dir" in resp["message"]


def test_classify_terraform_from_plan_output():
    # A large change with destroys, on a prod dir -> destructive.
    plan = "\n".join([
        '{"type":"change_summary","changes":{"add":1,"change":0,"remove":3}}',
    ])
    resp = handle_request({
        "id": "r2",
        "method": "iac.classify_blast_radius",
        "params": {
            "tool": "terraform",
            "working_dir": "/infra/prod",
            "git_branch": "main",
            "plan_output": plan,
        },
    })
    assert resp["type"] == "done"
    result = resp["result"]
    # destroy>0 in production -> destructive
    assert result["tier"] == "destructive"
    assert result["destroy"] == 3
    # terraform almost certainly not installed in CI -> source is parsed-output
    assert result["source"] in ("parsed-output", "fresh-plan")


def test_classify_ansible_production():
    resp = handle_request({
        "id": "r3",
        "method": "iac.classify_blast_radius",
        "params": {
            "tool": "ansible",
            "working_dir": "/infra/prod",
            "git_branch": "main",
            "has_destructive_tag": True,
        },
    })
    assert resp["type"] == "done"
    assert resp["result"]["tier"] == "destructive"
