"""Validator for sidecar/data/workflows_seed.yaml.

Ensures the seed pack stays consistent with the contract enforced by Rust
(`workflows_seed.rs`) and TS (`workflowsYaml.ts`):

* every entry has a unique id
* vendor + param.type values are within the allowed enums
* every `{{ placeholder }}` token has a declared param of the same name
* steps are 0-indexed and contiguous
"""

import re
from pathlib import Path

import yaml

SEED = Path(__file__).parent.parent.parent / "data" / "workflows_seed.yaml"
ALLOWED_VENDORS = {"cisco", "juniper", "arista", "meraki", "generic"}
ALLOWED_TYPES = {"string", "enum", "ip", "int", "interface"}
PLACEHOLDER_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


def _load():
    return yaml.safe_load(SEED.read_text())


def test_seed_loads_and_has_minimum_workflows():
    doc = _load()
    assert doc["version"] == 1
    wfs = doc["workflows"]
    assert len(wfs) >= 30, f"expected >=30 seed workflows, got {len(wfs)}"


def test_seed_ids_are_unique():
    doc = _load()
    ids = [wf["id"] for wf in doc["workflows"]]
    assert len(ids) == len(set(ids)), f"duplicate ids in seed: {ids}"


def test_seed_vendors_and_param_types_are_allowed():
    doc = _load()
    for wf in doc["workflows"]:
        assert (
            wf["vendor"] in ALLOWED_VENDORS
        ), f"{wf['id']}: vendor {wf['vendor']} not in {ALLOWED_VENDORS}"
        for p in wf.get("params", []):
            assert (
                p["type"] in ALLOWED_TYPES
            ), f"{wf['id']}: bad param type {p['type']}"


def test_seed_steps_are_zero_indexed_and_contiguous():
    doc = _load()
    for wf in doc["workflows"]:
        steps = wf["steps"]
        assert isinstance(steps, list) and len(steps) >= 1
        for i, step in enumerate(steps):
            assert (
                step["idx"] == i
            ), f"{wf['id']}: step idx {step['idx']} != position {i}"
            assert "command_template" in step and step["command_template"]


def test_seed_placeholders_match_declared_params():
    doc = _load()
    for wf in doc["workflows"]:
        declared = {p["name"] for p in wf.get("params", [])}
        for step in wf["steps"]:
            tokens = PLACEHOLDER_RE.findall(step["command_template"])
            for tok in tokens:
                assert tok in declared, (
                    f"{wf['id']}: placeholder {{{{{tok}}}}} not declared"
                )


def test_seed_vendor_distribution():
    """Plan 02 spec: cisco-iosxe (15) + nxos (3) + juniper (3) + arista (3)
    + generic (6) = 30 baseline. Meraki API workflows are excluded until
    workflows dispatch through the API runner instead of PTY writes."""
    doc = _load()
    by_vendor: dict[str, int] = {}
    for wf in doc["workflows"]:
        by_vendor[wf["vendor"]] = by_vendor.get(wf["vendor"], 0) + 1
    assert by_vendor.get("cisco", 0) >= 18, by_vendor
    assert by_vendor.get("juniper", 0) >= 3, by_vendor
    assert by_vendor.get("arista", 0) >= 3, by_vendor
    assert by_vendor.get("generic", 0) >= 6, by_vendor
