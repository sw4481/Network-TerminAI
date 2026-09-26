"""Catalog grounding is shared by every code-capable agent.

The raw catalogs can be very large (Meraki is ~900 entries), so they must stay
inside the Python sandbox.  The model sees only a small discovery instruction
and bounded search results.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from ccie_sidecar.agents.catalog_grounding import (
    CatalogApiError,
    CatalogGroundingError,
    CatalogIndex,
    catalog_prompt_hint,
    install_catalog_grounding,
    load_catalogs_for_agent,
)


REPO_ROOT = Path(__file__).resolve().parents[3]
BUNDLED = REPO_ROOT / "bundled-agents"


def _catalog(catalog_id: str) -> dict:
    return {
        "id": catalog_id,
        "entries": json.loads(
            (BUNDLED / catalog_id.replace("_", "-") / "tools.json").read_text()
        ),
    }


def test_ise_health_search_finds_real_mnt_version_and_is_bounded():
    index = CatalogIndex([_catalog("ise")])

    result = index.search("ISE server health", catalog_id="ise")

    assert any(
        match.get("path") == "/admin/API/mnt/Version"
        for match in result["matches"]
    )
    assert len(result["matches"]) <= 5
    assert len(json.dumps(result)) < 8_000
    assert "STOP SEARCHING" in result["instruction"]
    assert "result['matches']" in result["instruction"]
    assert "DO NOT import" in result["instruction"]


def test_repeated_discovery_without_a_real_call_is_bounded_and_resets():
    calls: list[tuple[str, str]] = []

    def real_call(method: str, path: str, **_kwargs) -> str:
        calls.append((method, path))
        return json.dumps({"status_code": 200, "data": {"version": "3.3"}})

    sandbox = {"ise_api_call": real_call}
    install_catalog_grounding(sandbox, [_catalog("ise")])
    catalog = sandbox["api_catalog"]

    for query in ("health", "server", "version", "status"):
        assert catalog.search(query, catalog_id="ise")["matches"]

    with pytest.raises(CatalogGroundingError, match="discovery budget exhausted"):
        catalog.search("enumerate everything", catalog_id="ise")

    # A real, previously discovered helper call resets the consecutive-search
    # budget so multi-endpoint tasks can continue discovery normally.
    sandbox["ise_api_call"]("GET", "/admin/API/mnt/Version")
    assert calls == [("GET", "/admin/API/mnt/Version")]
    assert catalog.search("active sessions", catalog_id="ise")["matches"]


def test_identical_catalog_search_is_never_replayed_in_one_turn():
    index = CatalogIndex([_catalog("ise")])

    assert index.search("ISE node status health", catalog_id="ise")["matches"]

    with pytest.raises(CatalogGroundingError, match="identical catalog search"):
        index.search("  ise NODE status   HEALTH ", catalog_id="ise")


def test_documented_endpoint_requires_catalog_discovery_before_network_call():
    calls: list[tuple[str, str]] = []

    def real_call(method: str, path: str, **_kwargs) -> str:
        calls.append((method, path))
        return json.dumps({"status_code": 200, "data": {"version": "3.3"}})

    sandbox = {"ise_api_call": real_call}
    install_catalog_grounding(sandbox, [_catalog("ise")])

    with pytest.raises(CatalogGroundingError, match="api_catalog.search"):
        sandbox["ise_api_call"]("GET", "/admin/API/mnt/Version")
    assert calls == []

    found = sandbox["api_catalog"].search("server health version", catalog_id="ise")
    assert found["matches"]
    payload = json.loads(
        sandbox["ise_api_call"]("GET", "/admin/API/mnt/Version")
    )
    assert payload["status_code"] == 200
    assert calls == [("GET", "/admin/API/mnt/Version")]


def test_unknown_path_is_rejected_without_network_io():
    calls: list[tuple[str, str]] = []
    sandbox = {
        "ise_api_call": lambda method, path, **_kwargs: calls.append((method, path))
    }
    install_catalog_grounding(sandbox, [_catalog("ise")])
    sandbox["api_catalog"].search("server health", catalog_id="ise")

    with pytest.raises(CatalogGroundingError, match="not documented"):
        sandbox["ise_api_call"]("GET", "/admin/API/mnt/SystemStatus")
    assert calls == []


def test_object_operation_catalogs_are_guarded_too():
    calls: list[str] = []

    class FakeGnmi:
        def targets(self):
            calls.append("targets")
            return {"ok": True, "data": ["router-1"]}

        def get(self, *_args, **_kwargs):
            calls.append("get")
            return {"ok": False, "error": "device unavailable"}

    sandbox = {"gnmi": FakeGnmi()}
    install_catalog_grounding(sandbox, [_catalog("gnmi")])

    with pytest.raises(CatalogGroundingError, match="has not been discovered"):
        sandbox["gnmi"].targets()
    assert calls == []

    search = sandbox["api_catalog"].search("list targets", catalog_id="gnmi")
    assert search["matches"][0]["operation"] == "targets"
    assert sandbox["gnmi"].targets()["ok"] is True
    assert calls == ["targets"]

    sandbox["api_catalog"].search("get state", catalog_id="gnmi")
    with pytest.raises(CatalogApiError, match="device unavailable"):
        sandbox["gnmi"].get("router-1", ["interfaces"])
    with pytest.raises(CatalogGroundingError, match="already failed"):
        sandbox["gnmi"].get("router-1", ["interfaces"])
    assert calls == ["targets", "get"]


def test_http_failure_is_an_error_and_identical_retry_never_hits_network_twice():
    calls = 0

    def failing_call(method: str, path: str, **_kwargs) -> str:
        nonlocal calls
        calls += 1
        return json.dumps({"status_code": 404, "data": None, "error": "not found"})

    sandbox = {"ise_api_call": failing_call}
    install_catalog_grounding(sandbox, [_catalog("ise")])
    sandbox["api_catalog"].search("active sessions", catalog_id="ise")

    with pytest.raises(CatalogApiError, match="HTTP 404"):
        sandbox["ise_api_call"]("GET", "/admin/API/mnt/Session/ActiveList")
    with pytest.raises(CatalogGroundingError, match="already failed"):
        sandbox["ise_api_call"]("GET", "/admin/API/mnt/Session/ActiveList")
    assert calls == 1


def test_meraki_catalog_repairs_generated_extra_plural_suffixes():
    index = CatalogIndex([_catalog("meraki")])

    result = index.search("list organization networks", catalog_id="meraki")

    assert any(
        match.get("method") == "GET"
        and match.get("path") == "/organizations/{organizationId}/networks"
        for match in result["matches"]
    )


def test_meraki_heartbeat_catalog_authorizes_current_scoped_routes():
    """The heartbeat's four read paths must be discoverable and authorized."""
    index = CatalogIndex([_catalog("meraki")])
    result = index.search(
        "getOrganizations getOrganizationNetworks "
        "getOrganizationDevicesStatuses getOrganizationAssuranceAlerts",
        catalog_id="meraki",
        limit=5,
    )

    assert {
        "/organizations",
        "/organizations/{organizationId}/networks",
        "/organizations/{organizationId}/devices/statuses",
        "/organizations/{organizationId}/assurance/alerts",
    }.issubset({match.get("path") for match in result["matches"]})

    for path in (
        "/organizations",
        "/organizations/{organizationId}/networks",
        "/organizations/{organizationId}/devices/statuses",
        "/organizations/{organizationId}/assurance/alerts",
    ):
        index.require_authorized("meraki", "GET", path)


@pytest.mark.parametrize(
    ("sdk_method", "method", "expected_path"),
    [
        (
            "getNetworkSwitchAccessPolicies",
            "GET",
            "/networks/{networkId}/switch/accessPolicies",
        ),
        (
            "getNetworkSwitchAccessPolicy",
            "GET",
            "/networks/{networkId}/switch/accessPolicies/{accessPolicyNumber}",
        ),
        (
            "createNetworkSwitchAccessPolicy",
            "POST",
            "/networks/{networkId}/switch/accessPolicies",
        ),
        (
            "updateNetworkSwitchAccessPolicy",
            "PUT",
            "/networks/{networkId}/switch/accessPolicies/{accessPolicyNumber}",
        ),
        (
            "deleteNetworkSwitchAccessPolicy",
            "DELETE",
            "/networks/{networkId}/switch/accessPolicies/{accessPolicyNumber}",
        ),
    ],
)
def test_meraki_access_policy_catalog_authorizes_current_routes(
    sdk_method,
    method,
    expected_path,
):
    index = CatalogIndex([_catalog("meraki")])

    result = index.search(sdk_method, catalog_id="meraki", limit=1)

    assert result["matches"][0]["method"] == method
    assert result["matches"][0]["path"] == expected_path
    index.require_authorized("meraki", method, expected_path)


def test_http_catalog_match_exposes_callable_helper_not_sdk_style_name():
    index = CatalogIndex([_catalog("meraki")])

    result = index.search(
        "getNetworkSwitchAccessPolicies",
        catalog_id="meraki",
        limit=1,
    )

    match = result["matches"][0]
    assert match["helper"] == "meraki_api_call"
    assert match["method"] == "GET"
    assert match["path"] == "/networks/{networkId}/switch/accessPolicies"
    assert "name" not in match
    assert "exact returned helper" in result["instruction"]
    assert "Never execute a catalog label as Python" in result["instruction"]


def test_network_architect_prefers_current_bundled_catalog_to_installed_snapshot(
    tmp_path,
):
    user_root = tmp_path / "user"
    bundled_root = tmp_path / "bundled"
    agent_frontmatter = """---
name: meraki
attached-tools:
  - id: meraki
    catalog: tools.json
---
"""

    def write_catalog(root, path):
        agent_dir = root / "meraki"
        agent_dir.mkdir(parents=True)
        (agent_dir / "AGENT.md").write_text(agent_frontmatter)
        (agent_dir / "tools.json").write_text(
            json.dumps(
                [
                    {
                        "name": "meraki.switch.list-network-switch-access-policies",
                        "description": "List switch access policies.",
                        "endpoint": {"method": "GET", "path": path},
                        "sdk_method": "getNetworkSwitchAccessPolicies",
                        "args": {},
                        "required": [],
                        "blast_radius": "low",
                    }
                ]
            )
        )

    write_catalog(user_root, "/networks/{networkId}/switchs")
    write_catalog(bundled_root, "/networks/{networkId}/switch/accessPolicies")

    catalogs = load_catalogs_for_agent(
        "network-architect",
        user_agents_dir=user_root,
        bundled_agents_dir=bundled_root,
    )
    match = CatalogIndex(catalogs).search(
        "getNetworkSwitchAccessPolicies",
        catalog_id="meraki",
        limit=1,
    )["matches"][0]

    assert match["path"] == "/networks/{networkId}/switch/accessPolicies"
    assert json.loads((user_root / "meraki" / "tools.json").read_text())[0][
        "endpoint"
    ]["path"] == "/networks/{networkId}/switchs"


@pytest.mark.parametrize(
    ("sdk_method", "expected_path"),
    [
        ("getOrganizations", "/organizations"),
        (
            "getOrganizationNetworks",
            "/organizations/{organizationId}/networks",
        ),
        (
            "getOrganizationDevicesStatuses",
            "/organizations/{organizationId}/devices/statuses",
        ),
        (
            "getOrganizationAssuranceAlerts",
            "/organizations/{organizationId}/assurance/alerts",
        ),
    ],
)
def test_meraki_legacy_sdk_names_find_their_exact_rest_records(
    sdk_method,
    expected_path,
):
    pytest.importorskip("meraki")
    index = CatalogIndex([_catalog("meraki")])

    result = index.search(sdk_method, catalog_id="meraki", limit=1)

    assert result["matches"][0]["method"] == "GET"
    assert result["matches"][0]["path"] == expected_path


def test_meraki_heartbeat_batch_search_authorizes_all_required_endpoints():
    pytest.importorskip("meraki")
    index = CatalogIndex([_catalog("meraki")])

    result = index.search(
        "getOrganizations getOrganizationNetworks "
        "getOrganizationDevicesStatuses getOrganizationAssuranceAlerts",
        catalog_id="meraki",
        limit=5,
    )

    paths = {
        (match.get("method"), match.get("path"))
        for match in result["matches"]
    }
    required = {
        ("GET", "/organizations"),
        ("GET", "/organizations/{organizationId}/networks"),
        ("GET", "/organizations/{organizationId}/devices/statuses"),
        ("GET", "/organizations/{organizationId}/assurance/alerts"),
    }
    assert required <= paths
    for method, path in required:
        index.require_authorized("meraki", method, path)


def test_meraki_uses_installed_official_sdk_path_metadata_when_available():
    pytest.importorskip("meraki")
    index = CatalogIndex([_catalog("meraki")])

    result = index.search(
        "meraki.organizations.list-inventory-devices",
        catalog_id="meraki",
        limit=1,
    )

    assert result["matches"][0]["path"] == (
        "/organizations/{organizationId}/inventory/devices"
    )

    wireless = index.search(
        "meraki.wireless.list-organization-wireless-ssids-firewall-isolation-allowlist-entries",
        catalog_id="meraki",
        limit=1,
    )
    assert "/wireless/ssids/" in wireless["matches"][0]["path"]


def test_forbidden_auth_path_does_not_taint_later_documented_endpoints():
    index = CatalogIndex([_catalog("aci")])
    index.search("fabric health class", catalog_id="aci")

    index.require_authorized(
        "aci", "GET", "/api/node/class/fabricHealthTotal.json"
    )
    index.search("aaa login auth", catalog_id="aci")
    with pytest.raises(CatalogGroundingError, match="explicitly forbidden"):
        index.require_authorized("aci", "GET", "/api/aaaLogin")


def test_prompt_hint_is_constant_size_and_contains_no_raw_catalog_descriptions():
    huge = "RAW-CATALOG-SENTINEL " * 20_000
    catalogs = [
        {
            "id": f"vendor_{idx}",
            "entries": [
                {
                    "name": f"vendor_{idx}_api_call",
                    "description": huge,
                    "type": "function",
                    "function": {
                        "name": f"vendor_{idx}_api_call",
                        "description": huge,
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
        }
        for idx in range(25)
    ]

    hint = catalog_prompt_hint(CatalogIndex(catalogs))

    assert len(hint) < 2_000
    assert "RAW-CATALOG-SENTINEL" not in hint
    assert "search_api_catalog" in hint
    assert "current/live platform facts" in hint
    assert "real pre-bound helper call" in hint
    assert "STOP searching" in hint
    assert "result['matches']" in hint
    assert "inventory() takes no arguments" in hint
    assert "NEVER import" in hint


def test_deepagents_tool_keeps_catalog_in_sandbox_not_description():
    from ccie_sidecar.agents.deepagents_tools import (
        create_catalog_search_tool,
        create_execute_python_code_tool,
    )

    tool = create_execute_python_code_tool(
        "ise",
        {},
        lambda _event: None,
        catalogs=[_catalog("ise")],
    )

    assert len(tool.description) < 4_000
    assert "search_api_catalog" in tool.description
    assert "never `import ise`" in tool.description
    assert "/admin/API/mnt/Version" not in tool.description
    search_tool = create_catalog_search_tool(tool)
    assert search_tool is not None
    assert search_tool.name == "search_api_catalog"
    assert "/admin/API/mnt/Version" not in search_tool.description
    assert set(tool.args_schema.model_json_schema()["properties"]) == {"code"}
    assert "execute_python_code" in search_tool.description
    assert "matches[*].helper" in search_tool.description
    assert "matches[*].method" in search_tool.description
    assert "matches[*].path" in search_tool.description
    assert "SDK-shaped catalog label" in search_tool.description
    assert "matches[*].operation" not in search_tool.description
    found = search_tool.invoke({
        "query": "ISE server health",
        "catalog_id": "ise",
    })
    assert found["matches"][0]["catalog_id"] == "ise"
    assert any(
        match.get("path") == "/admin/API/mnt/Version"
        for match in found["matches"]
    )
    result = tool.invoke(
        {"code": "print(api_catalog.search('server health', catalog_id='ise'))"}
    )
    assert "/admin/API/mnt/Version" in result


def test_native_catalog_search_returns_a_recoverable_budget_error():
    from ccie_sidecar.agents.deepagents_tools import (
        create_catalog_search_tool,
        create_execute_python_code_tool,
    )

    execute_tool = create_execute_python_code_tool(
        "ise",
        {},
        lambda _event: None,
        catalogs=[_catalog("ise")],
    )
    search_tool = create_catalog_search_tool(execute_tool)
    assert search_tool is not None

    for query in ("health", "server", "version", "status"):
        assert search_tool.invoke(
            {"query": query, "catalog_id": "ise"}
        )["matches"]

    exhausted = search_tool.invoke(
        {"query": "enumerate everything", "catalog_id": "ise"}
    )

    assert exhausted["ok"] is False
    assert exhausted["error_type"] == "CatalogGroundingError"
    assert "discovery budget exhausted" in exhausted["error"]
    assert "STOP SEARCHING" in exhausted["instruction"]


def test_network_architect_tool_description_stays_bounded_with_many_huge_catalogs(
    monkeypatch,
):
    from ccie_sidecar.agents import architect_subagents as architect
    from ccie_sidecar.agents import code_exec

    huge = "ARCHITECT-RAW-CATALOG-SENTINEL " * 20_000
    specs = [
        {
            "id": f"vendor_{idx}",
            "display": f"Vendor {idx}",
            "when": "testing",
            "configured": lambda: True,
        }
        for idx in range(20)
    ]
    catalogs = [
        {
            "id": spec["id"],
            "entries": [
                {
                    "name": f"{spec['id']}_api_call",
                    "description": huge,
                    "type": "function",
                    "function": {
                        "name": f"{spec['id']}_api_call",
                        "description": huge,
                        "parameters": {"type": "object", "properties": {}},
                    },
                }
            ],
        }
        for spec in specs
    ]

    def fake_sandbox(cli_package, *_args, **_kwargs):
        if cli_package is None:
            return {"json": json}
        return {
            f"{cli_package}_api_call": (
                lambda method, path: json.dumps({"status_code": 200, "data": {}})
            )
        }

    monkeypatch.setattr(architect, "VENDOR_SPECS", specs)
    monkeypatch.setattr(code_exec, "_build_sandbox_globals", fake_sandbox)
    monkeypatch.setattr(code_exec, "_build_env_overrides", lambda _secrets: {})

    tool, configured = architect.build_architect_direct_tool(catalogs=catalogs)
    from ccie_sidecar.agents.deepagents_tools import create_catalog_search_tool
    search_tool = create_catalog_search_tool(tool)

    assert configured == [spec["id"] for spec in specs]
    assert search_tool is not None
    assert search_tool.name == "search_api_catalog"
    assert len(tool.description) < 15_000
    assert "ARCHITECT-RAW-CATALOG-SENTINEL" not in tool.description
    assert "search_api_catalog" in tool.description


def test_network_architect_runtime_prompt_is_compact_and_non_conflicting(
    monkeypatch,
    tmp_path,
):
    from ccie_sidecar import agent as agent_loader

    monkeypatch.setattr(agent_loader, "_agents_dir", lambda: tmp_path / "agents")
    agent = agent_loader.load_agent("network-architect")

    assert agent is not None
    prompt = agent["system_prompt"]
    assert len(prompt) < 10_000
    assert "search_api_catalog" in prompt
    assert "You do NOT call vendor APIs yourself" not in prompt
    assert "# SOUL-EXPERTISE" not in prompt
    assert "/admin/API/mnt/Version" not in prompt


def test_legacy_user_network_architect_copy_does_not_restore_soul_prompt(
    monkeypatch,
    tmp_path,
):
    from ccie_sidecar import agent as agent_loader

    agent_dir = tmp_path / "agents" / "network-architect"
    agent_dir.mkdir(parents=True)
    (agent_dir / "AGENT.md").write_text(
        "---\nname: network-architect\nsystem-prompt: compact core\n---\nbody\n",
        encoding="utf-8",
    )
    (agent_dir / "SOUL-EXPERTISE.md").write_text(
        "# SOUL-EXPERTISE\nlarge reference",
        encoding="utf-8",
    )
    monkeypatch.setattr(agent_loader, "_agents_dir", lambda: tmp_path / "agents")

    agent = agent_loader.load_agent("network-architect")

    assert agent is not None
    assert agent["system_prompt"] == "compact core"


def test_every_bundled_catalog_normalizes_without_entering_the_prompt():
    catalogs = []
    for path in sorted(BUNDLED.glob("*/tools.json")):
        entries = json.loads(path.read_text())
        catalog_id = entries[0].get("function", {}).get("name", "").removesuffix(
            "_api_call"
        )
        if not catalog_id:
            catalog_id = "secure_endpoint" if path.parent.name == "secure-endpoint" else path.parent.name
        catalogs.append({"id": catalog_id, "entries": entries})

    index = CatalogIndex(catalogs)
    inventory = index.inventory()
    hint = catalog_prompt_hint(index)

    assert len(inventory["catalogs"]) == len(catalogs)
    assert all(item["record_count"] >= 1 for item in inventory["catalogs"])
    assert len(hint) < 2_000
    assert "Assign SM seats to a network" not in hint
