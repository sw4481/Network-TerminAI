from ccie_sidecar.agents.architect_subagents import (
    VENDOR_SPECS,
    build_vendor_subagents,
    build_architect_direct_tool,
    configured_vendor_ids,
    _cfg,
)


def test_secure_endpoint_in_vendor_specs():
    ids = [s["id"] for s in VENDOR_SPECS]
    assert "secure_endpoint" in ids
    spec = next(s for s in VENDOR_SPECS if s["id"] == "secure_endpoint")
    assert "isolat" in spec["when"].lower() or "endpoint" in spec["when"].lower()


def test_secure_endpoint_specialist_built_when_included():
    # include_unconfigured=True forces every vendor's subagent to be built.
    subs = build_vendor_subagents(include_unconfigured=True)
    names = [s["name"] for s in subs]
    assert "secure_endpoint-specialist" in names


def test_architect_direct_tool_documents_secure_endpoint():
    tool, ids = build_architect_direct_tool(include_unconfigured=True)
    assert "secure_endpoint" in ids
    assert "secure_endpoint_api_call" in tool.description


def test_cfg_accepts_secure_endpoint_client_id_config():
    """Regression: the architect's _cfg gate must treat a Secure Endpoint config
    (keyed on client_id, NO host/token) as 'configured'. The earlier
    include_unconfigured=True tests did not exercise this real gate, so a
    fully-configured Secure Endpoint was invisible to the network-architect."""
    import sys
    import types as _types
    fake = _types.ModuleType("ccie_sidecar._fake_se_cfg")
    fake.get = lambda: {
        "region": "nam", "auth_mode": "v1_basic",
        "client_id": "cid", "api_key": "key", "verify_ssl": True,
    }
    sys.modules["ccie_sidecar._fake_se_cfg"] = fake
    try:
        assert _cfg("ccie_sidecar._fake_se_cfg", "get") is True
        # An empty client_id is NOT configured.
        fake.get = lambda: {"region": "nam", "client_id": "", "api_key": ""}
        assert _cfg("ccie_sidecar._fake_se_cfg", "get") is False
    finally:
        del sys.modules["ccie_sidecar._fake_se_cfg"]


def test_configured_vendor_ids_includes_secure_endpoint_when_set(monkeypatch):
    """When get_secure_endpoint_config returns a real client_id, the architect's
    configured-vendor menu must include secure_endpoint."""
    monkeypatch.setattr(
        "ccie_sidecar.secure_endpoint_config.get_secure_endpoint_config",
        lambda: {
            "region": "nam", "auth_mode": "v1_basic",
            "client_id": "cid", "api_key": "key", "verify_ssl": True,
        },
    )
    assert "secure_endpoint" in configured_vendor_ids()
