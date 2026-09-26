from ccie_sidecar.agents.architect_subagents import (
    VENDOR_SPECS,
    build_vendor_subagents,
    build_architect_direct_tool,
    configured_vendor_ids,
    _cfg,
)


def test_cisco_xdr_in_vendor_specs():
    ids = [s["id"] for s in VENDOR_SPECS]
    assert "cisco_xdr" in ids
    spec = next(s for s in VENDOR_SPECS if s["id"] == "cisco_xdr")
    w = spec["when"].lower()
    assert "xdr" in w or "observable" in w or "detection" in w


def test_cisco_xdr_specialist_built_when_included():
    subs = build_vendor_subagents(include_unconfigured=True)
    names = [s["name"] for s in subs]
    assert "cisco_xdr-specialist" in names


def test_architect_flatten_includes_cisco_xdr_inline():
    """cisco_xdr now runs INLINE in the architect sandbox like every other vendor
    (so the user sees code+results, not a single task() wrapper). The earlier
    /v1/computers contamination is prevented by XDR_CAPABILITIES_DOC's explicit
    'XDR is NOT a host inventory; NO /v1/computers' disambiguation rather than by
    excluding it."""
    from ccie_sidecar.agents.architect_subagents import DELEGATE_ONLY_VENDOR_IDS
    assert "cisco_xdr" not in DELEGATE_ONLY_VENDOR_IDS
    tool, ids = build_architect_direct_tool(include_unconfigured=True)
    assert "cisco_xdr" in ids
    assert "cisco_xdr_api_call" in tool.description
    # The inline catalog must carry the anti-contamination disambiguation.
    assert "NO /v1/computers" in tool.description


def test_cfg_accepts_cisco_xdr_client_id_config():
    """The architect's _cfg gate must treat a Cisco XDR config (keyed on
    client_id, NO host/token) as 'configured'."""
    import sys
    import types as _types
    fake = _types.ModuleType("ccie_sidecar._fake_xdr_cfg")
    fake.get = lambda: {
        "region": "nam", "client_id": "cid",
        "client_password": "secret", "verify_ssl": True,
    }
    sys.modules["ccie_sidecar._fake_xdr_cfg"] = fake
    try:
        assert _cfg("ccie_sidecar._fake_xdr_cfg", "get") is True
        fake.get = lambda: {"region": "nam", "client_id": "", "client_password": ""}
        assert _cfg("ccie_sidecar._fake_xdr_cfg", "get") is False
    finally:
        del sys.modules["ccie_sidecar._fake_xdr_cfg"]


def test_configured_vendor_ids_includes_cisco_xdr_when_set(monkeypatch):
    monkeypatch.setattr(
        "ccie_sidecar.cisco_xdr_config.get_cisco_xdr_config",
        lambda: {
            "region": "nam", "client_id": "cid",
            "client_password": "secret", "verify_ssl": True,
        },
    )
    assert "cisco_xdr" in configured_vendor_ids()
