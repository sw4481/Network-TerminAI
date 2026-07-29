"""Tests for the iac.generate_terraform_code / iac.generate_ansible_playbook RPC
methods (IaC Studio Phase C).

The RPC builds the Settings-page LLM via
iac_codegen_tools.build_default_codegen_llm(). These tests monkeypatch that one
symbol so no network/model is ever touched: a canned-JSON stub for the happy
path, and a raising stub for the unavailable path. validate=False is forced by
the absence of the terraform/ansible binaries in CI (codegen skips validation
gracefully), so assertions never depend on a real binary.
"""
from __future__ import annotations

import json

import ccie_sidecar.agents.iac_codegen_tools as codegen_tools
from ccie_sidecar.server import handle_request


def _stub_llm(payload: dict):
    def _call(_prompt: str) -> str:
        return json.dumps(payload)
    return _call


def test_generate_terraform_requires_intent():
    resp = handle_request({
        "id": "g1",
        "method": "iac.generate_terraform_code",
        "params": {"working_dir": "/infra"},
    })
    assert resp["type"] == "error"
    assert "intent" in resp["message"]


def test_generate_terraform_happy_path(monkeypatch):
    payload = {
        "code": 'resource "aws_s3_bucket" "b" {}',
        "filename": "s3.tf",
        "explanation": "an s3 bucket",
        "estimated_apply_time_seconds": 5,
    }
    monkeypatch.setattr(
        codegen_tools, "build_default_codegen_llm", lambda: _stub_llm(payload)
    )
    resp = handle_request({
        "id": "g2",
        "method": "iac.generate_terraform_code",
        "params": {"intent": "make an s3 bucket", "working_dir": "/infra"},
    })
    assert resp["type"] == "done"
    result = resp["result"]
    assert result["tool"] == "terraform"
    assert result["unavailable"] is False
    assert "aws_s3_bucket" in result["code"]
    assert result["filename"] == "s3.tf"


def test_generate_terraform_unavailable_on_llm_failure(monkeypatch):
    def _boom():
        def _call(_p: str) -> str:
            raise RuntimeError("model down")
        return _call
    monkeypatch.setattr(codegen_tools, "build_default_codegen_llm", _boom)
    resp = handle_request({
        "id": "g3",
        "method": "iac.generate_terraform_code",
        "params": {"intent": "make an s3 bucket", "working_dir": "/infra"},
    })
    assert resp["type"] == "done"  # never an error — honest unavailable result
    assert resp["result"]["unavailable"] is True
    assert resp["result"]["code"] == ""


def test_generate_ansible_happy_path(monkeypatch):
    payload = {
        "playbook": "- hosts: all\n  tasks: []\n",
        "filename": "play.yml",
        "explanation": "a noop play",
        "target_host_count": 1,
    }
    monkeypatch.setattr(
        codegen_tools, "build_default_codegen_llm", lambda: _stub_llm(payload)
    )
    resp = handle_request({
        "id": "g4",
        "method": "iac.generate_ansible_playbook",
        "params": {"intent": "noop play", "working_dir": "/infra"},
    })
    assert resp["type"] == "done"
    assert resp["result"]["tool"] == "ansible"
    assert resp["result"]["unavailable"] is False
    assert "hosts: all" in resp["result"]["code"]


def test_generate_ansible_requires_intent():
    resp = handle_request({
        "id": "g5",
        "method": "iac.generate_ansible_playbook",
        "params": {"working_dir": "/infra"},
    })
    assert resp["type"] == "error"
    assert "intent" in resp["message"]


def test_generate_ansible_forwards_existing_code_to_prompt(monkeypatch):
    """The RPC must thread `existing_code` into the codegen context so the model
    edits the open playbook instead of generating a fresh one."""
    seen = {}

    def _capturing_llm():
        def _call(prompt: str) -> str:
            seen["prompt"] = prompt
            return json.dumps({
                "playbook": "---\n- hosts: all\n  tasks: []\n",
                "filename": "play.yml",
                "explanation": "edited",
                "target_host_count": 1,
            })
        return _call

    monkeypatch.setattr(codegen_tools, "build_default_codegen_llm", _capturing_llm)
    resp = handle_request({
        "id": "g6",
        "method": "iac.generate_ansible_playbook",
        "params": {
            "intent": "add router eigrp 12",
            "working_dir": "/infra",
            "existing_code": "---\n- name: Gather IOS device facts\n  hosts: all\n",
        },
    })
    assert resp["type"] == "done"
    # The existing file content must appear in the prompt the model saw.
    assert "Gather IOS device facts" in seen["prompt"]
    assert "EXISTING PLAYBOOK" in seen["prompt"]


def test_generate_pipeline_requires_valid_platform():
    resp = handle_request({
        "id": "p0",
        "method": "iac.generate_pipeline",
        "params": {"tool": "terraform", "flow": "plan-on-PR"},
    })
    assert resp["type"] == "error"
    assert "platform" in resp["message"]


def test_generate_pipeline_happy_path(monkeypatch):
    payload = {
        "code": "stages:\n  - plan\n  - apply\n",
        "filename": ".gitlab-ci.yml",
        "explanation": "gitlab pipeline",
        "estimated_apply_time_seconds": 5,
    }
    monkeypatch.setattr(
        codegen_tools, "build_default_codegen_llm", lambda: _stub_llm(payload)
    )
    resp = handle_request({
        "id": "p1",
        "method": "iac.generate_pipeline",
        "params": {"platform": "gitlab", "tool": "terraform",
                   "flow": "plan-on-PR + apply-on-merge", "auth": "AWS via OIDC"},
    })
    assert resp["type"] == "done"
    assert resp["result"]["tool"] == "pipeline"
    assert resp["result"]["code"].startswith("stages:")
    assert resp["result"]["unavailable"] is False
