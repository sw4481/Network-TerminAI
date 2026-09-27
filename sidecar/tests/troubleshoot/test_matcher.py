"""Plan 15 Phase 5 — symptom-to-playbook matcher tests.

Six scenarios per the plan. The embedder-dependent test
(`test_embedding_catches_synonym_neighbor_peer`) auto-skips when the
ONNX model files aren't bundled in the test environment so CI without
the weights still passes.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

import pytest
import yaml

from ccie_sidecar.troubleshoot.matcher import BM25, match_symptom


SEEDS_DIR = (
    Path(__file__).resolve().parents[2]
    / "src"
    / "ccie_sidecar"
    / "troubleshoot"
    / "seeds"
)


def _load_seeds() -> list[dict[str, Any]]:
    """Load the six builtin playbook YAMLs as plain dicts.

    We use ``yaml.safe_load`` directly rather than the validating
    loader to keep the tests focused on the matcher (the loader is
    exhaustively tested in ``test_yaml_loader.py``).
    """
    out: list[dict[str, Any]] = []
    for path in sorted(SEEDS_DIR.glob("*.yaml")):
        out.append(yaml.safe_load(path.read_text()))
    return out


def _run(coro):
    """Tiny sync helper around ``asyncio.run`` for readable tests."""
    return asyncio.run(coro)


# ---------------------------------------------------------------------------
# Disambiguation scenarios
# ---------------------------------------------------------------------------


def test_bgp_symptom_ranks_bgp_first() -> None:
    """A symptom dripping with BGP keywords must rank `bgp-wont-peer`
    above the other five seeds."""
    seeds = _load_seeds()
    results = _run(
        match_symptom(
            "BGP neighbor 10.0.0.5 stuck in Idle",
            vendor="cisco",
            platform="iosxe",
            playbooks=seeds,
        )
    )
    assert results, "matcher returned no candidates"
    assert results[0]["id"] == "bgp-wont-peer", results
    # And the score should be comfortably above the UI's 0.35 threshold.
    assert results[0]["score"] > 0.35


def test_ospf_init_symptom_picks_ospf_over_bgp() -> None:
    """OSPF Init / ExStart must beat BGP even though both are 'neighbor'
    playbooks. Word-overlap on `init` and `ospf` should dominate."""
    seeds = _load_seeds()
    results = _run(
        match_symptom(
            "OSPF neighbor stuck in ExStart, MTU mismatch suspected",
            vendor="cisco",
            platform="iosxe",
            playbooks=seeds,
        )
    )
    ids = [r["id"] for r in results]
    assert "ospf-neighbor-init" in ids
    # Top hit is OSPF, not BGP.
    assert results[0]["id"] == "ospf-neighbor-init", ids


def test_errdisable_symptom_ranks_interface_playbook() -> None:
    """`err-disabled` is a high-signal phrase. The interface playbook
    must come out on top."""
    seeds = _load_seeds()
    results = _run(
        match_symptom(
            "Interface Gi1/0/1 went err-disabled with bpduguard",
            vendor="cisco",
            platform="iosxe",
            playbooks=seeds,
        )
    )
    assert results[0]["id"] == "interface-err-disabled"


def test_generic_symptom_below_threshold_returns_low_scores() -> None:
    """Garbage symptom should score below the 0.35 UI threshold across
    every candidate. The function still returns its top-5 (the UI is
    where the threshold is enforced)."""
    seeds = _load_seeds()
    results = _run(
        match_symptom(
            "purple monkey dishwasher",
            vendor="cisco",
            platform="iosxe",
            playbooks=seeds,
        )
    )
    # The matcher always returns up to top-5 — UI enforces the cutoff.
    if results:
        assert max(r["score"] for r in results) < 0.35


def test_vendor_filter_excludes_incompatible_playbooks() -> None:
    """A playbook with vendor 'juniper' must NOT appear when the caller
    asks for vendor 'cisco'. We synthesize a Juniper playbook to test
    this; the seeds are all Cisco."""
    seeds = _load_seeds()
    juniper = {
        "id": "junos-bgp-flap",
        "name": "Junos BGP flapping",
        "symptom_keywords": ["bgp", "neighbor", "junos"],
        "vendor": "juniper",
        "platform": "junos",
        "description": "Junos-specific BGP diagnostic",
        "steps": [],
    }
    playbooks = seeds + [juniper]
    results = _run(
        match_symptom(
            "BGP neighbor stuck in Idle",
            vendor="cisco",
            platform="iosxe",
            playbooks=playbooks,
        )
    )
    ids = [r["id"] for r in results]
    assert "junos-bgp-flap" not in ids
    # The Cisco BGP playbook should still come out on top.
    assert "bgp-wont-peer" in ids


def test_embedding_catches_synonym_neighbor_peer() -> None:
    """The embedder should associate "neighbor" with "peer" even when
    BM25 alone wouldn't connect them.

    Skips automatically when the ONNX MiniLM weights aren't bundled
    (e.g. CI hosts without the model files).
    """
    pytest.importorskip("onnxruntime")
    pytest.importorskip("tokenizers")

    from ccie_sidecar.rag.embed import MODEL_DIR

    if not (MODEL_DIR / "onnx" / "model.onnx").exists():
        pytest.skip("MiniLM ONNX weights not present in this environment")

    # A synthetic playbook that uses "peer" but not "neighbor", and
    # vice versa for the symptom — pure BM25 would miss the link.
    peer_pb = {
        "id": "peer-synonym",
        "name": "Peer session diagnostic",
        "symptom_keywords": ["peer", "session", "tcp"],
        "vendor": "*",
        "platform": "*",
        "description": "Diagnoses peer session failures.",
        "steps": [],
    }
    unrelated = {
        "id": "dhcp-unrelated",
        "name": "DHCP scope diagnosis",
        "symptom_keywords": ["dhcp", "lease", "scope"],
        "vendor": "*",
        "platform": "*",
        "description": "Unrelated DHCP diagnostic.",
        "steps": [],
    }
    results = _run(
        match_symptom(
            "neighbor adjacency",
            vendor=None,
            platform=None,
            playbooks=[peer_pb, unrelated],
        )
    )
    assert results, "no matches returned"
    # The peer playbook must beat the unrelated DHCP one.
    assert results[0]["id"] == "peer-synonym"


# ---------------------------------------------------------------------------
# Auxiliary tests — verify the BM25 internals + edge cases
# ---------------------------------------------------------------------------


def test_match_symptom_returns_top_5_max() -> None:
    """Even with seven candidates the matcher truncates to five."""
    base = _load_seeds()
    extras = [
        {
            "id": f"extra-{i}",
            "name": f"Extra playbook {i} bgp",
            "symptom_keywords": ["bgp", "extra", str(i)],
            "vendor": "*",
            "platform": "*",
            "description": "extra",
            "steps": [],
        }
        for i in range(3)
    ]
    results = _run(
        match_symptom(
            "bgp neighbor",
            vendor=None,
            platform=None,
            playbooks=base + extras,
        )
    )
    assert len(results) <= 5


def test_empty_symptom_returns_empty() -> None:
    """An empty symptom string short-circuits to no matches."""
    results = _run(match_symptom("", None, None, _load_seeds()))
    assert results == []


def test_no_playbooks_returns_empty() -> None:
    """An empty catalogue short-circuits to no matches."""
    results = _run(match_symptom("bgp idle", None, None, []))
    assert results == []


def test_reasons_include_keyword_match_strings() -> None:
    """Reasons should explain *why* — keyword-match strings are the
    most actionable signal for users."""
    seeds = _load_seeds()
    results = _run(
        match_symptom(
            "BGP neighbor stuck in Idle",
            vendor="cisco",
            platform="iosxe",
            playbooks=seeds,
        )
    )
    top = results[0]
    assert any("keyword" in r for r in top["reasons"]), top["reasons"]


def test_wildcard_vendor_matches_anything() -> None:
    """A playbook with vendor `*` must match any caller vendor."""
    pb = {
        "id": "any-vendor",
        "name": "Any vendor diagnostic bgp",
        "symptom_keywords": ["bgp", "any"],
        "vendor": "*",
        "platform": "*",
        "description": "wildcard",
        "steps": [],
    }
    results = _run(
        match_symptom(
            "bgp issue",
            vendor="arista",
            platform="eos",
            playbooks=[pb],
        )
    )
    assert results
    assert results[0]["id"] == "any-vendor"


def test_bm25_score_handles_empty_corpus() -> None:
    """BM25 over an empty corpus should not crash."""
    bm = BM25([])
    assert bm.score_all(["bgp"]) == []
