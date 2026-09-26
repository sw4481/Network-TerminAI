"""Tests for the Proxmox capability catalog."""
from ccie_sidecar.proxmox_api import catalog


def test_every_capability_has_name_doc_and_risk():
    assert catalog.CAPABILITIES, "catalog must not be empty"
    for cap in catalog.CAPABILITIES:
        assert cap.name and isinstance(cap.name, str)
        assert cap.group and isinstance(cap.group, str)
        assert cap.signature and isinstance(cap.signature, str)
        assert cap.doc and len(cap.doc) >= 20, f"{cap.name} doc too short"
        assert cap.risk in ("read", "mutate", "high_risk"), cap.name


def test_high_risk_set_matches_expected():
    high = {c.name for c in catalog.CAPABILITIES if c.risk == "high_risk"}
    assert {
        "delete_vm", "delete_container", "delete_snapshot", "rollback_snapshot",
        "restore_backup", "delete_backup", "delete_iso",
        "execute_vm_command", "execute_container_command",
    } <= high


def test_confusable_pairs_contrast_each_other():
    docs = {c.name: c.doc.lower() for c in catalog.CAPABILITIES}
    # stop vs shutdown
    assert "graceful" in docs["shutdown_vm"]
    assert "pull" in docs["stop_vm"] or "hard" in docs["stop_vm"]
    # delete vs rollback snapshot
    assert "revert" in docs["rollback_snapshot"]
    assert "data" in docs["rollback_snapshot"]  # warns about data loss
    assert "removes a snapshot" in docs["delete_snapshot"] or "does not" in docs["delete_snapshot"]


def test_help_lists_all_capabilities():
    out = catalog.help()
    for cap in catalog.CAPABILITIES:
        assert cap.name in out


def test_help_topic_filters_and_shows_signature():
    out = catalog.help("snapshot")
    assert "create_snapshot" in out
    assert "rollback_snapshot" in out
    assert "(" in out  # shows signatures
    assert "get_nodes" not in out


def test_search_matches_doc_text():
    names = catalog.search("revert")
    assert "rollback_snapshot" in names
