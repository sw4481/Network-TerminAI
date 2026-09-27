"""Tests for the IOS-XE CLI <-> NETCONF/XML translation helper.

Offline tests run everywhere. The schema_tree / model tests need a downloaded
Cisco XE YANG release and are skipped when the cache is absent.
"""
import os
from pathlib import Path

import pytest

from ccie_sidecar.iosxe_translate import IosxeTranslate, _added_lines, _is_exec


def _has_native_model() -> bool:
    base = Path.home() / ".ccie-terminal" / "yang-cache" / "cisco" / "xe"
    return base.exists() and any(
        (r / "Cisco-IOS-XE-native.yang").exists() for r in base.glob("*")
    )


needs_yang = pytest.mark.skipif(
    not _has_native_model(),
    reason="No Cisco XE YANG in ~/.ccie-terminal/yang-cache (download via YANG browser)",
)


# -- Tier C: cli-rpc envelope (port-parity with netconf_runner::cli_wrapper) ----

def test_cli_to_rpc_wraps_config():
    h = IosxeTranslate()
    out = h.cli_to_rpc("interface Loopback99\n description test")
    assert out["ok"] is True
    assert out["tier"] == "C"
    xml = out["data"]["xml"]
    assert '<config-ios-cli-rpc xmlns="http://cisco.com/ns/yang/Cisco-IOS-XE-cli-rpc">' in xml
    assert "<config-clis>" in xml
    assert "interface Loopback99" in xml
    assert "description test" in xml
    assert "<rpc" not in xml  # session layer adds the <rpc> wrapper


def test_cli_to_rpc_rejects_show():
    out = IosxeTranslate().cli_to_rpc("show version")
    assert out["ok"] is False
    assert "SSH" in out["error"]
    assert out["tier"] == "C"


def test_cli_to_rpc_rejects_empty():
    out = IosxeTranslate().cli_to_rpc("   ")
    assert out["ok"] is False
    assert "empty" in out["error"].lower()


def test_cli_to_rpc_escapes_xml():
    out = IosxeTranslate().cli_to_rpc("banner motd #<test>#")
    assert "&lt;test&gt;" in out["data"]["xml"]
    assert "<test>" not in out["data"]["xml"]


def test_is_exec_heuristic():
    assert _is_exec("show version")
    assert _is_exec("PING 1.1.1.1")
    assert not _is_exec("interface Loopback0")
    assert not _is_exec("no ip domain-lookup")


def test_added_lines_is_order_independent_set_diff():
    before = "a\nb\nc"
    after = "a\nb\nc\nd interface\n e desc"
    assert _added_lines(before, after) == ["d interface", " e desc"]


# -- envelope shape ------------------------------------------------------------

def test_device_methods_error_without_testbed():
    h = IosxeTranslate(pyats_client=None)
    for out in (
        h.cli_to_native("R1", "interface Lo1", "native/interface/Loopback=1"),
        h.native_to_cli("R1", "<x/>", "native/interface/Loopback=1"),
    ):
        assert out["ok"] is False
        assert out["tier"] == "A"
        assert out["blast_radius"] == "high"
        assert "pyATS" in out["error"]


def test_restconf_url_qualifies_bare_native_path():
    h = IosxeTranslate()
    url = h._restconf_url("10.0.0.1", "native/interface/Loopback=1")
    assert url == ("https://10.0.0.1/restconf/data/"
                   "Cisco-IOS-XE-native:native/interface/Loopback=1")
    # an already-qualified path is left alone
    url2 = h._restconf_url("10.0.0.1", "Cisco-IOS-XE-native:native/hostname")
    assert url2.endswith("Cisco-IOS-XE-native:native/hostname")


def test_native_to_cli_rejects_bad_method():
    out = IosxeTranslate(pyats_client=object()).native_to_cli(
        "R1", "<x/>", "native/hostname", method="DELETE")
    assert out["ok"] is False
    # object() has no .testbed, so device resolution fails first; either way it
    # must be a Tier A high-blast error, never a silent success.
    assert out["tier"] == "A" and out["blast_radius"] == "high"


# -- Tier B: model-grounded (needs downloaded YANG) ----------------------------

@needs_yang
def test_models_lists_native():
    out = IosxeTranslate().models(filter="native")
    assert out["ok"] is True and out["tier"] == "B"
    assert "Cisco-IOS-XE-native" in out["data"]["modules"]


@needs_yang
def test_schema_tree_returns_real_leaves():
    out = IosxeTranslate().schema_tree(
        "Cisco-IOS-XE-native", path="native/interface", depth=3)
    assert out["ok"] is True and out["tier"] == "B"
    assert "module: Cisco-IOS-XE-native" in out["data"]["tree"]
    assert "interface" in out["data"]["tree"]
    assert out["data"]["namespace"] == "http://cisco.com/ns/yang/Cisco-IOS-XE-native"


@needs_yang
def test_schema_tree_resolves_augmented_subtree():
    # router/eigrp is augmented into native from Cisco-IOS-XE-eigrp; native
    # alone dead-ends at an empty `router`. The helper must auto-load the
    # augmenting module so real leaves render.
    out = IosxeTranslate().schema_tree(
        "Cisco-IOS-XE-native", path="native/router/eigrp", depth=5)
    assert out["ok"] is True
    assert "ios-eigrp:network" in out["data"]["tree"]
    assert "Cisco-IOS-XE-eigrp" in (out["data"]["augmented_by"] or [])


@needs_yang
def test_schema_tree_unknown_module_errors():
    out = IosxeTranslate().schema_tree("Not-A-Real-Module")
    assert out["ok"] is False
    assert "models()" in out["error"]


@needs_yang
def test_validate_native_accepts_known_namespace():
    xml = ('<native xmlns="http://cisco.com/ns/yang/Cisco-IOS-XE-native">'
           '<hostname>R1</hostname></native>')
    out = IosxeTranslate().validate_native(xml)
    assert out["ok"] is True
    assert out["data"]["valid"] is True
    assert "Cisco-IOS-XE-native" in out["data"]["modules"]


@needs_yang
def test_validate_native_rejects_unknown_namespace():
    xml = '<native xmlns="http://example.com/bogus"><hostname>R1</hostname></native>'
    out = IosxeTranslate().validate_native(xml)
    assert out["data"]["valid"] is False
    assert out["data"]["errors"]


def test_validate_native_rejects_malformed_xml():
    out = IosxeTranslate().validate_native("<not-closed>")
    assert out["ok"] is False
    assert "Malformed" in out["error"]
