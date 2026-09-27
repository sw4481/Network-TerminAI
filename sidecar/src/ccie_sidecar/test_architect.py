"""Tests for the Network Architect orchestrator: soul-file scoping + subagents."""
from pathlib import Path
from unittest.mock import patch


# ---- Meraki specialist gets the key via env even with no vault secret --------

def test_meraki_env_override_from_config_when_no_vault_secret():
    """The architect's meraki specialist passes vault_secrets={}; the Meraki SDK
    env vars must still be set from the Settings config so model code that
    re-instantiates DashboardAPI() (no api_key=) works."""
    from ccie_sidecar.agents import code_exec
    with patch.object(
        code_exec, "_build_env_overrides", code_exec._build_env_overrides
    ):
        with patch("ccie_sidecar.meraki_config.get_meraki_config",
                   return_value={"api_key": "CFGKEY", "org_id": "1"}):
            env = code_exec._build_env_overrides({})
    assert env.get("MERAKI_API_KEY") == "CFGKEY"
    assert env.get("MERAKI_DASHBOARD_API_KEY") == "CFGKEY"


def test_vault_secret_still_wins_for_meraki_env():
    """A vault-injected key (standalone Meraki agent) is preferred over config."""
    from ccie_sidecar.agents import code_exec
    with patch("ccie_sidecar.meraki_config.get_meraki_config",
               return_value={"api_key": "CFGKEY"}):
        env = code_exec._build_env_overrides({"meraki_api_key": "VAULTKEY"})
    assert env["MERAKI_API_KEY"] == "VAULTKEY"


# ---- SOUL-file concatenation is opt-in and does not leak to other agents ----

def test_soul_files_appended_only_when_present(tmp_path):
    from ccie_sidecar.agent import _append_soul_files
    # No SOUL files -> unchanged.
    base = "BASE PROMPT"
    assert _append_soul_files(tmp_path, base) == base
    # With SOUL files -> appended in sorted order.
    (tmp_path / "SOUL.md").write_text("IDENTITY BLOCK")
    (tmp_path / "SOUL-EXPERTISE.md").write_text("EXPERTISE BLOCK")
    out = _append_soul_files(tmp_path, base)
    assert out.startswith("BASE PROMPT")
    assert "IDENTITY BLOCK" in out
    assert "EXPERTISE BLOCK" in out
    # SOUL.md sorts before SOUL-EXPERTISE.md.
    assert out.index("IDENTITY BLOCK") < out.index("EXPERTISE BLOCK")


def test_soul_file_char_cap(tmp_path):
    from ccie_sidecar.agent import _append_soul_files, _SOUL_FILE_CHAR_CAP
    (tmp_path / "SOUL.md").write_text("x" * (_SOUL_FILE_CHAR_CAP + 500))
    out = _append_soul_files(tmp_path, "")
    assert "…(truncated)" in out
    assert len(out) <= _SOUL_FILE_CHAR_CAP + 50


def test_other_agents_unchanged_by_soul_feature():
    """A normal agent (no SOUL files) must load with exactly its frontmatter prompt."""
    from ccie_sidecar.agent import load_agent
    cml = load_agent("cml")
    assert cml is not None
    sp = cml["system_prompt"]
    # No architect/persona leakage.
    assert "Network Architect" not in sp
    assert "aci-specialist" not in sp
    assert sp.lstrip().startswith("You are a Cisco Modeling Labs")


def test_network_architect_loads_with_soul():
    from ccie_sidecar.agent import load_agent
    arch = load_agent("network-architect")
    assert arch is not None
    sp = arch["system_prompt"]
    assert "ROUTING MATRIX" in sp                 # frontmatter system-prompt
    assert "non-negotiable rules" in sp.lower()    # SOUL.md
    assert "BGP" in sp                              # SOUL-EXPERTISE.md
    assert "aci-specialist" in sp                   # SOUL-SKILLS.md
    assert arch["attached_tools"] == []             # orchestrator binds no vendor


def test_zabbix_agent_prompt_separates_reads_from_approval_writes():
    from ccie_sidecar.agent import load_agent
    zabbix = load_agent("zabbix")
    assert zabbix is not None
    prompt = zabbix["system_prompt"]
    assert "zabbix_api_call" in prompt
    assert "Never call zabbix_apply for a read" in prompt
    assert "Do not import or inspect zabbix_api" in prompt
    assert "json.loads(zabbix_api_call" in prompt
    assert "records = result['data']" in prompt


# ---- Subagent builder: skip-unconfigured + correct per-vendor isolation ----

def test_build_subagents_skips_unconfigured(monkeypatch):
    import ccie_sidecar.agents.architect_subagents as A
    # Force every vendor "unconfigured".
    for spec in A.VENDOR_SPECS:
        spec_local = spec
    with patch.object(A, "_safe", return_value=False):
        subs = A.build_vendor_subagents()
    assert subs == []


def test_build_subagents_include_all_binds_one_vendor_each():
    from ccie_sidecar.agents.architect_subagents import build_vendor_subagents, VENDOR_SPECS
    subs = build_vendor_subagents(include_unconfigured=True)
    assert len(subs) == len(VENDOR_SPECS)
    names = {s["name"] for s in subs}
    assert "aci-specialist" in names
    assert "thousandeyes-specialist" in names
    # Each specialist has exactly one tool.
    for s in subs:
        assert len(s["tools"]) == 1
        assert s["name"].endswith("-specialist")
        assert s["description"].startswith("Delegate here for:")


def test_specialist_sandbox_is_vendor_isolated():
    """The aci specialist's sandbox must bind aci_api_call, not other vendors."""
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    g = _build_sandbox_globals("aci", {}, emit=lambda e: None)
    assert "aci_api_call" in g
    assert "cml_api_call" not in g
    assert "fmc_api_call" not in g


def test_architect_direct_tool_binds_all_vendors_in_one_sandbox():
    """The flatten: the orchestrator's own tool binds EVERY vendor helper at once
    so a single question is answered inline without delegating."""
    from ccie_sidecar.agents.architect_subagents import build_architect_direct_tool
    tool, ids = build_architect_direct_tool(include_unconfigured=True)
    # One tool, named execute_python_code, describing every platform.
    assert tool.name == "execute_python_code"
    desc = tool.description
    assert "CONFIGURED PLATFORMS" in desc
    for vid in ("aci", "cml", "fmc", "ise", "thousandeyes", "meraki"):
        assert vid in ids
        assert vid in desc
    # Globals helpers are present alongside the vendors.
    assert "uml" in desc or "markmap" in desc


def test_configured_vendor_ids_reads_real_config():
    """Smoke: configured_vendor_ids returns a subset of known vendor ids."""
    from ccie_sidecar.agents.architect_subagents import configured_vendor_ids, VENDOR_SPECS
    ids = set(configured_vendor_ids())
    known = {s["id"] for s in VENDOR_SPECS}
    assert ids.issubset(known)


def test_zabbix_is_available_to_architect_before_connection_setup(monkeypatch):
    """Zabbix is a bundled specialist: its helper must be visible so it can
    direct an unconfigured operator to Settings rather than being omitted."""
    import ccie_sidecar.agents.architect_subagents as A
    monkeypatch.setattr("ccie_sidecar.zabbix_config.get_zabbix_config", lambda: None)
    assert "zabbix" in A.configured_vendor_ids()
    _, ids = A.build_architect_direct_tool()
    assert "zabbix" in ids


def test_orchestrator_sandbox_binds_no_vendor():
    """The sentinel cli_package 'network-architect' must not bind any vendor."""
    from ccie_sidecar.agents.code_exec import _build_sandbox_globals
    g = _build_sandbox_globals("network-architect", {}, emit=lambda e: None)
    vendor_helpers = [
        k for k in (
            "aci_api_call", "cml_api_call", "ise_api_call", "fmc_api_call",
            "gnmi", "thousandeyes_api_call", "stealthwatch_api_call",
            "catalyst_center_api_call",
        ) if k in g
    ]
    assert vendor_helpers == []
    assert all(k in g for k in ("uml", "markmap", "wikipedia", "rfc"))
