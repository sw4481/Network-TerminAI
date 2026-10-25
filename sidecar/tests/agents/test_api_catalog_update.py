"""Additive updates extend one effective catalog, never other products or callers."""
from __future__ import annotations

import json
import shutil
import threading
import time
from pathlib import Path

import pytest

from ccie_sidecar.agents.catalog_grounding import (
    CatalogGroundingError, CatalogIndex, install_catalog_grounding,
    load_catalogs_for_agent, resolve_agent_catalogs,
)

BUNDLED = Path(__file__).resolve().parents[3] / "bundled-agents"
PRODUCTS = (
    "stealthwatch", "ise", "cml", "catalyst-center", "splunk", "aci", "fmc",
    "thousandeyes", "meraki", "secure-endpoint", "cisco-xdr",
)
PATHS = {
    "stealthwatch": "/sw-reporting/v1/newWidgets",
    "ise": "/ers/config/newWidget", "cml": "/newWidgets",
    "catalyst-center": "/dna/intent/api/v1/newWidgets",
    "splunk": "/services/newWidgets", "aci": "/api/node/class/newWidget.json",
    "fmc": "/api/fmc_config/v1/domain/{domainUUID}/newWidgets",
    "thousandeyes": "/v7/newWidgets",
    "meraki": "/organizations/{organizationId}/newWidgets",
    "secure-endpoint": "/v1/newWidgets", "cisco-xdr": "/iroh/iroh-enrich/newWidgets",
}


def operation(path="/ers/config/newWidget", method="POST"):
    schema = {"type": "object", "properties": {
        "policy": {"type": "object", "properties": {"enabled": {"type": "boolean"}},
                   "required": ["enabled"]}}, "required": ["policy"]}
    return {
        "name": "createNewWidget", "description": "Create a new widget",
        "endpoint": {"method": method, "path": path},
        "args": {"body": schema}, "required": ["body"],
        "api_details": {"parameters": [], "request_body": {"content_type": "application/json",
            "required": True, "schema": schema}, "components": {}},
        "api_update": {"source_url": "https://developer.cisco.com/docs/fixture/spec.json",
            "source_sha256": "a" * 64, "retrieved_at": "2026-10-16T12:00:00+00:00",
            "source_pointer": "/paths/~1ers~1config~1newWidget/post"},
    }


@pytest.mark.parametrize("vendor", ["ise", "stealthwatch", "splunk"])
def test_nested_addition_is_usable_by_standalone_and_architect_without_replacing_caller(tmp_path, vendor):
    installed = tmp_path / "agents"
    shutil.copytree(BUNDLED / vendor, installed / vendor)
    target = installed / vendor / "tools.json"
    old = json.loads(target.read_text())
    added = operation(PATHS[vendor])
    target.write_text(json.dumps(old + [added]))
    standalone = load_catalogs_for_agent(vendor, user_agents_dir=installed, bundled_agents_dir=tmp_path / "none")
    architect = load_catalogs_for_agent("network-architect", user_agents_dir=installed, bundled_agents_dir=tmp_path / "none")
    assert standalone[0]["entries"][:-1] == old
    for catalogs in (standalone, architect):
        called = []
        helper = lambda method, path, **kwargs: called.append((method, path, kwargs)) or '{"status_code":200}'
        sandbox = {f"{vendor}_api_call": helper}
        index = install_catalog_grounding(sandbox, catalogs)
        detail = index.describe(PATHS[vendor], vendor, method="POST")
        schema = detail["matches"][0]["api_details"]["request_body"]["schema"]
        assert schema["properties"]["policy"]["required"] == ["enabled"]
        sandbox[f"{vendor}_api_call"]("POST", PATHS[vendor], body={"policy": {"enabled": True}})
        assert called == [("POST", PATHS[vendor], {"body": {"policy": {"enabled": True}}})]
    assert resolve_agent_catalogs({"catalogs": standalone, "id": vendor}) == standalone
    assert resolve_agent_catalogs({"attached_tools": [{"id": vendor, "catalog": old + [added]}]}) == standalone


def test_describe_selects_method_and_retrieves_large_required_input_by_local_pointer():
    get, post = operation(method="GET"), operation()
    post["api_details"]["request_body"]["schema"]["properties"]["lateRequired"] = {
        "type": "string", "description": "x" * 20000}
    post["api_details"]["request_body"]["schema"]["required"].append("lateRequired")
    index = CatalogIndex([{"id": "ise", "entries": [get, post]}])
    result = index.describe("/ers/config/newWidget", "ise", method="POST")
    assert result["matches"][0]["method"] == "POST"
    assert len(json.dumps(result)) < 16000
    assert result["truncated"] is True
    assert result["continuations"]
    required = index.describe("/ers/config/newWidget", "ise", method="POST",
                              schema_pointer="/request_body/schema/required")
    assert required["detail"] == ["policy", "lateRequired"]
    with pytest.raises(CatalogGroundingError):
        index.describe("/ers/config/newWidget", "ise", schema_pointer="https://evil.invalid/schema")


def test_imported_allow_never_overrides_explicit_or_prose_denial():
    denied, allowed = operation(), operation()
    denied["allowed"] = False
    allowed["name"] = "renamedAllowed"
    index = CatalogIndex([{"id": "ise", "entries": [denied, allowed]}])
    index.search("create new widget", "ise")
    with pytest.raises(CatalogGroundingError, match="forbidden"):
        index.require_authorized("ise", "POST", "/ers/config/newWidget")


def test_native_search_exposes_method_specific_input_details_and_local_paging():
    from ccie_sidecar.agents.deepagents_tools import create_catalog_search_tool, create_execute_python_code_tool
    tool = create_execute_python_code_tool("ise", {}, lambda _: None,
        catalogs=[{"id": "ise", "entries": [operation(method="GET"), operation()]}])
    search = create_catalog_search_tool(tool)
    found = search.invoke({"query": "create widget", "catalog_id": "ise"})
    assert any(match.get("has_input_details") for match in found["matches"])
    result = search.invoke({"query": PATHS["ise"], "catalog_id": "ise", "method": "POST", "schema_pointer": ""})
    assert result["matches"][0]["method"] == "POST"
    assert result["detail"]["request_body"]["schema"]["required"] == ["policy"]
    required = search.invoke({"query": PATHS["ise"], "catalog_id": "ise", "method": "POST",
                              "schema_pointer": "/request_body/schema/required"})
    assert required["detail"] == ["policy"]
    assert "schema_pointer" in search.description


def test_identical_key_denial_is_preserved_regardless_of_order():
    allow, deny = operation(), operation()
    deny["allowed"] = False
    for entries in ([deny, allow], [allow, deny]):
        index = CatalogIndex([{"id": "ise", "entries": entries}])
        index.search("new widget", "ise")
        with pytest.raises(CatalogGroundingError, match="forbidden"):
            index.require_authorized("ise", "POST", PATHS["ise"])


def test_response_only_reference_cycle_does_not_discard_input_schema(installed):
    document = json.loads(spec("ise"))
    document["components"]["schemas"]["Recursive"] = {"$ref": "#/components/schemas/Recursive"}
    document["paths"][PATHS["ise"]]["post"]["responses"] = {"200": {"$ref": "#/components/schemas/Recursive"}}
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")},
        fetcher=lambda _: json.dumps(document).encode())
    assert len(updater.collect_candidates("ise")["candidates"]) == 1


def test_total_schema_alias_expansion_is_bounded():
    value = {"leaf": "ok"}
    for _ in range(20):
        value = {"a": value, "b": value}
    with pytest.raises(ValueError, match="traversal"):
        updater_class()._bounded_tree(value)


def test_deadline_is_checked_immediately_before_atomic_replace(installed, monkeypatch):
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")}, fetcher=lambda _: spec("ise"))
    original_fsync = __import__("os").fsync
    flushes = []
    def expire_after_flush(fd):
        original_fsync(fd)
        flushes.append(fd)
        if len(flushes) == 2:
            updater._deadlines["ise"] = 0
    monkeypatch.setattr("ccie_sidecar.agents.api_catalog_update.os.fsync", expire_after_flush)
    before = (installed / "ise" / "tools.json").read_bytes()
    result = wait(updater, "ise", updater.start("ise"))
    assert result["state"] == "failed"
    assert (installed / "ise" / "tools.json").read_bytes() == before


@pytest.mark.parametrize("security,expected", [
    ([{"basic": []}], 1), ([{"bearer": []}], 0),
    ([{"bearer": []}, {"basic": []}], 1),
    ([{"bearer": [], "basic": []}], 0), ([], 1),
])
def test_inherited_security_must_fit_one_existing_client_mode(installed, security, expected):
    document = json.loads(spec("ise"))
    document["security"] = security
    document["components"]["securitySchemes"] = {
        "basic": {"type": "http", "scheme": "basic"}, "bearer": {"type": "http", "scheme": "bearer"}}
    config = {**source("ise"), "security_modes": [["http:basic"]]}
    updater = updater_class()(user_agents_dir=installed, sources={"ise": config}, fetcher=lambda _: json.dumps(document).encode())
    result = updater.collect_candidates("ise")
    assert len(result["candidates"]) == expected
    assert bool(result["skipped"]) is not bool(expected)


def test_swagger_multipart_cannot_be_relabelled_as_form(installed):
    document = {"swagger": "2.0", "info": {"version": "1"}, "paths": {PATHS["splunk"]: {
        "post": {"consumes": ["multipart/form-data"], "parameters": [{"in": "formData", "name": "file",
            "type": "file", "required": True}], "responses": {}}}}}
    config = {**source("splunk"), "body_content_types": ["application/x-www-form-urlencoded"]}
    result = updater_class()(user_agents_dir=installed, sources={"splunk": config},
        fetcher=lambda _: json.dumps(document).encode()).collect_candidates("splunk")
    assert not result["candidates"]
    assert result["skipped"] == 1


def test_custom_generic_caller_method_restriction_is_not_expanded(installed):
    target = installed / "ise" / "tools.json"
    entries = json.loads(target.read_text())
    entries[0]["function"]["parameters"]["properties"] = {"method": {"type": "string", "enum": ["GET"]}}
    target.write_text(json.dumps(entries))
    original = target.read_bytes()
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")}, fetcher=lambda _: spec("ise"))
    result = wait(updater, "ise", updater.start("ise"))
    assert result["added"] == 0
    assert result["skipped"] == 1
    assert target.read_bytes() == original


def test_significant_trailing_slash_remains_distinct(installed):
    target = installed / "ise" / "tools.json"
    target.write_text(json.dumps([operation()]))
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")},
        fetcher=lambda _: spec("ise", path=PATHS["ise"] + "/"))
    result = wait(updater, "ise", updater.start("ise"))
    assert result["added"] == 1
    assert json.loads(target.read_text())[-1]["endpoint"]["path"].endswith("/")


@pytest.mark.parametrize("suffix", ["../other.json", "%2e%2e/other.json", "%252e%252e/other.json"])
def test_source_path_cannot_escape_approved_product_prefix(installed, suffix):
    config = source("ise")
    config["roots"] = ["https://developer.cisco.com/docs/fixture/"]
    updater = updater_class()(sources={"ise": config}, user_agents_dir=installed)
    with pytest.raises(ValueError):
        updater._approved_url(config["roots"][0] + suffix, config)


def test_imported_endpoints_are_not_projected_as_legacy_model_functions():
    from ccie_sidecar.agents.catalog_grounding import legacy_function_catalog
    from ccie_sidecar.agents.react import _convert_catalog_to_tools
    original = {"name": "meraki.organizations.list-organizations", "args": {}, "required": []}
    catalog = [original, operation("/organizations/newWidget")]
    for value in (catalog, json.dumps(catalog), {"entries": catalog}):
        projected = legacy_function_catalog(value)
        assert projected == [original]
        assert len(_convert_catalog_to_tools(projected, "anthropic")) == 1
    assert CatalogIndex([{"id": "meraki", "entries": catalog}]).describe("/organizations/newWidget", "meraki", method="POST")["matches"][0]["has_input_details"]


def test_ambiguous_catalog_envelope_cannot_shadow_existing_denial(installed):
    target = installed / "ise" / "tools.json"
    denied = operation()
    denied["allowed"] = False
    original = json.dumps({"tools": [], "entries": [denied]}).encode()
    target.write_bytes(original)
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")}, fetcher=lambda _: spec("ise"))
    result = wait(updater, "ise", updater.start("ise"))
    assert result["state"] == "failed"
    assert target.read_bytes() == original


def test_imported_meraki_path_is_not_repaired_as_legacy_english():
    path = "/networks/{networkId}/wireless/ssids/{number}/newWidget"
    index = CatalogIndex([{"id": "meraki", "entries": [operation(path)]}])
    assert index.describe(path, "meraki", method="POST")["matches"][0]["path"] == path
    index.require_authorized("meraki", "POST", path)


def test_swagger_root_base_path_does_not_create_double_slash(installed):
    document = {"swagger": "2.0", "basePath": "/", "paths": {PATHS["ise"]: {"get": {"responses": {}}}}}
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")},
        fetcher=lambda _: json.dumps(document).encode())
    assert updater.collect_candidates("ise")["candidates"][0]["endpoint"]["path"] == PATHS["ise"]


def test_prose_without_compatible_authentication_evidence_is_skipped(installed):
    page = b'<p>GET /ers/config/newWidget</p><p>Requires X-Widget-Key header.</p>'
    candidate = {"name": "getWidget", "description": "Get widget", "method": "GET",
        "path": PATHS["ise"], "parameters": [], "request_body": None,
        "evidence": {"method_path": "GET /ers/config/newWidget", "input_schema": ""}}
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")},
        fetcher=lambda _: page, extractor=lambda _: {"operations": [candidate]})
    result = updater.collect_candidates("ise")
    assert not result["candidates"]
    assert result["skipped"] == 1


@pytest.mark.parametrize("product,scheme,capabilities,accepted", [
    ("ise", "Bearer", ["header:authorization"], False),
    ("cml", "Basic", ["header:authorization"], False),
    ("ise", "Basic", ["header:authorization"], False),
    ("cml", "Bearer", ["header:authorization"], False),
    ("ise", "Basic", ["header:authorization", "http:basic"], True),
    ("cml", "Bearer", ["header:authorization", "http:bearer"], True),
])
def test_prose_authorization_header_requires_explicit_compatible_scheme(product, scheme, capabilities, accepted):
    updater = updater_class()()
    quote = f"Authorization: {scheme} authentication required."
    endpoint = f"GET {PATHS[product]}"
    candidate = {"method": "GET", "path": PATHS[product], "parameters": [], "request_body": None,
        "authentication": {"capabilities": capabilities, "evidence": quote},
        "evidence": {"method_path": endpoint, "input_schema": ""}}
    assert updater._prose_evidence(candidate, endpoint + "\n" + quote, updater.sources[product]) is accepted


@pytest.mark.parametrize("proxy", ["http://proxy.invalid:8080", "https://proxy.invalid:8080"])
def test_ipv6_proxy_connect_host_is_bracketed_and_publisher_tls_retained(proxy):
    from ccie_sidecar.agents.api_catalog_update import _ReferenceTlsAdapter
    adapter = _ReferenceTlsAdapter("developer.cisco.com", "2606:4700:4700::1111")
    manager = adapter.proxy_manager_for(proxy)
    assert manager.proxy_headers["Host"] == "[2606:4700:4700::1111]:443"
    assert manager.connection_pool_kw["assert_hostname"] == "developer.cisco.com"
    assert manager.connection_pool_kw["server_hostname"] == "developer.cisco.com"


def test_reference_connection_pins_validated_address_and_tls_hostname(monkeypatch):
    import socket
    import requests
    from urllib.parse import urlsplit
    resolutions, sent = [], []
    def resolve(host, port, **kwargs):
        resolutions.append(host)
        address = "93.184.216.34" if len(resolutions) == 1 else "127.0.0.1"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, port))]
    def send(session, request, **kwargs):
        sent.append(request)
        assert urlsplit(request.url).hostname == "93.184.216.34"
        assert request.headers["Host"] == "developer.cisco.com"
        pool = session.get_adapter(request.url).poolmanager.connection_pool_kw
        assert pool["assert_hostname"] == "developer.cisco.com"
        assert pool["server_hostname"] == "developer.cisco.com"
        assert kwargs.get("verify", True) is not False
        response = requests.Response()
        response.status_code = 200
        response._content, response._content_consumed = b"reference", True
        return response
    monkeypatch.setattr("ccie_sidecar.agents.api_catalog_update.socket.getaddrinfo", resolve)
    monkeypatch.setattr("requests.utils.get_environ_proxies", lambda _: {})
    monkeypatch.setattr(requests.Session, "send", send)
    updater = updater_class()(sources={"ise": source("ise")})
    assert updater._fetch(source("ise")["roots"][0], source("ise"), time.monotonic() + 5) == (b"reference", source("ise")["roots"][0])
    assert len(sent) == 1
    assert resolutions == ["developer.cisco.com"]


@pytest.mark.parametrize("provider", ["anthropic", "openai"])
@pytest.mark.parametrize("lookups", [3, 49])
def test_legacy_schema_paging_preserves_execution_retries(monkeypatch, provider, lookups):
    import asyncio
    from ccie_sidecar.agents import code_exec
    record = operation()
    record["api_details"]["request_body"]["schema"]["properties"]["large"] = {"description": "x" * 20000}
    inputs = [
        {"query": "create widget", "catalog_id": "ise"},
        {"query": PATHS["ise"], "catalog_id": "ise", "method": "POST", "schema_pointer": ""},
        {"query": PATHS["ise"], "catalog_id": "ise", "method": "POST", "schema_pointer": "/request_body/schema/required"},
    ]
    if lookups > 3:
        inputs = [inputs[0]] + [inputs[1]] * (lookups - 1)
    responses = [{"stop_reason": "tool_use", "content": [{"type": "tool_use", "id": str(i),
        "name": "search_api_catalog", "input": value}]} for i, value in enumerate(inputs)]
    responses += [{"stop_reason": "tool_use", "content": [{"type": "tool_use", "id": "execute",
        "name": "execute_python_code", "input": {"code": "print('fixture')"}}]},
        {"stop_reason": "end_turn", "content": [{"type": "text", "text": "Complete"}]}]
    calls, executed, events = [], [], []
    async def llm(**kwargs):
        calls.append(kwargs)
        return responses[len(calls) - 1]
    def execute(*args, **kwargs):
        executed.append(args)
        return {"success": True, "output": "fixture", "error": ""}
    monkeypatch.setattr(code_exec, "_build_sandbox_globals", lambda *args, **kwargs: {"json": json})
    monkeypatch.setattr(code_exec, "_build_env_overrides", lambda _: {})
    monkeypatch.setattr(code_exec, "_execute_code_with_timeout", execute)
    monkeypatch.setattr("ccie_sidecar.agent.get_saved_config", lambda: {"provider": provider, "model": "fixture", "api_key": "fixture"})
    monkeypatch.setattr("ccie_sidecar.agents.graph_helper.memory_first_preamble", lambda: "")
    monkeypatch.setattr("ccie_sidecar.llm.call_llm", llm)
    definition = {"attached_tools": [{"id": "ise", "catalog": [record], "vault_secrets": {"fixture": "not-a-secret"}}]}
    asyncio.run(code_exec.code_exec_loop(definition, "Create widget", {}, events.append))
    if lookups > 3:
        assert not executed
        assert len(calls) == 49
        assert [event for event in events if event["type"] == "error"] == [{"type": "error",
            "message": "Catalog input-detail lookup limit exceeded; no further execution attempted."}]
        return
    assert len(executed) == 1
    assert len(calls) == 5
    assert [event for event in events if event["type"] == "final"] == [{"type": "final", "response": "Complete"}]
    assert json.loads([event["output"] for event in events if event["type"] == "code_result"][2])["detail"] == ["policy"]


def updater_class():
    from ccie_sidecar.agents.api_catalog_update import ApiCatalogUpdater
    return ApiCatalogUpdater


def source(vendor):
    return {
        "roots": ["https://developer.cisco.com/docs/fixture/spec.json"],
        "allowed_origins": ["https://developer.cisco.com"],
        "path_prefixes": [PATHS[vendor].split("newWidget")[0]],
        "methods": ["GET", "POST", "PUT", "PATCH", "DELETE"],
        "body_content_types": ["application/json"],
    }


def spec(vendor, *, path=None):
    return json.dumps({"openapi": "3.0.3", "info": {"title": "Fixture", "version": "1.0"},
        "paths": {path or PATHS[vendor]: {"post": {"operationId": "createNewWidget",
            "summary": "Create new widget", "requestBody": {"required": True,
                "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Widget"}}}}}}},
        "components": {"schemas": {"Widget": {"type": "object", "required": ["policy"],
            "properties": {"policy": {"type": "object", "required": ["enabled"],
                "properties": {"enabled": {"type": "boolean"}}}}}}}}).encode()


@pytest.fixture
def installed(tmp_path):
    root = tmp_path / "agents"
    for vendor in PRODUCTS:
        folder = root / vendor
        folder.mkdir(parents=True)
        cid = vendor.replace("-", "_")
        (folder / "AGENT.md").write_text(f"---\nname: {vendor}\nattached-tools:\n  - id: {cid}\n    catalog: tools.json\n---\nUser prompt must survive.\n")
        (folder / "tools.json").write_text(json.dumps([{"type": "function", "function": {
            "name": f"{cid}_api_call", "description": "GET /known", "parameters": {"type": "object"}}}]))
    return root


def wait(updater, vendor, job):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        result = updater.status(vendor, job["job_id"])
        if result["state"] != "running":
            return result
        time.sleep(0.005)
    pytest.fail("fixture update did not terminate")


@pytest.mark.parametrize("vendor", PRODUCTS)
@pytest.mark.parametrize("broken", [False, True])
def test_update_is_product_isolated_and_idempotent(installed, vendor, broken):
    snapshots = {p: p.read_bytes() for p in installed.rglob("*") if p.is_file()}
    cid = vendor.replace("-", "_")
    fetched = []
    def fetch(url):
        fetched.append(url)
        if broken:
            raise ValueError("fixture source unavailable")
        return spec(vendor)
    updater = updater_class()(user_agents_dir=installed, sources={cid: source(vendor)}, fetcher=fetch)
    result = wait(updater, vendor, updater.start(vendor))
    assert result["state"] == ("failed" if broken else "completed"), result
    assert result["added"] == (0 if broken else 1)
    for path, before in snapshots.items():
        if path != installed / vendor / "tools.json" or broken:
            assert path.read_bytes() == before
    if not broken:
        new = json.loads((installed / vendor / "tools.json").read_text())
        assert new[:-1] == json.loads(snapshots[installed / vendor / "tools.json"])
        assert new[-1]["api_details"]["request_body"]["schema"]["required"] == ["policy"]
        repeated = wait(updater, vendor, updater.start(vendor))
        assert repeated["added"] == 0
        assert repeated["already_known"] == 1
    assert fetched and set(fetched) == set(source(vendor)["roots"])
    assert updater.status(vendor)["job_id"] is not None


def test_running_job_status_is_fast_duplicate_reuses_job_other_product_is_busy(installed):
    entered, release = threading.Event(), threading.Event()
    def fetch(_url):
        entered.set()
        assert release.wait(2)
        return spec("ise")
    updater = updater_class()(user_agents_dir=installed, sources={v: source(v) for v in ("ise", "splunk")}, fetcher=fetch)
    assert updater.status("ise")["state"] == "idle"
    job = updater.start("ise")
    try:
        assert entered.wait(1)
        assert updater.status("ise")["state"] == "running"
        assert updater.start("ise")["job_id"] == job["job_id"]
        assert updater.start("splunk")["state"] == "busy"
        assert updater.status("splunk")["state"] == "idle"
    finally:
        release.set()
    assert wait(updater, "ise", job)["state"] == "completed"
    with pytest.raises(ValueError, match="Unknown|expired"):
        updater.status("ise", "wrong-id")
    with pytest.raises(ValueError):
        updater.start("../splunk")
    with pytest.raises(ValueError):
        updater.start("network-architect")


def test_changed_catalog_aborts_publication_without_overwriting_edit(installed):
    target = installed / "ise" / "tools.json"
    edited = '[{"name":"user-edit"}]'
    def fetch(_url):
        target.write_text(edited)
        return spec("ise")
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")}, fetcher=fetch)
    result = wait(updater, "ise", updater.start("ise"))
    assert result["state"] == "failed"
    assert "changed" in result["error"].lower()
    assert target.read_text() == edited


@pytest.mark.parametrize("envelope", ["tools", "entries"])
def test_object_envelope_and_custom_fields_survive_with_managed_backup(installed, envelope):
    target = installed / "ise" / "tools.json"
    original = {envelope: json.loads(target.read_text()), "custom": {"keep": True}}
    target.write_text(json.dumps(original))
    before = target.read_bytes()
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")}, fetcher=lambda _: spec("ise"))
    result = wait(updater, "ise", updater.start("ise"))
    assert result["state"] == "completed", result
    saved = json.loads(target.read_text())
    assert saved["custom"] == {"keep": True}
    assert saved[envelope][:-1] == original[envelope]
    backup = json.loads(target.with_name(target.name + ".api-update-backup.json").read_text())
    assert backup["owner"] == "terminai-api-catalog-updater-v1"
    assert backup["catalog"] == json.loads(before)


@pytest.mark.parametrize("rewrite", ["placeholder", "wildcard", "denied"])
def test_existing_template_wildcard_and_denial_are_not_shadowed(installed, rewrite):
    target = installed / "ise" / "tools.json"
    candidate = "/ers/config/newWidget/{newId}"
    old = operation("/ers/config/newWidget/{id}")
    if rewrite == "wildcard":
        old["endpoint"]["method"] = ""
    if rewrite == "denied":
        old["allowed"] = False
    target.write_text(json.dumps([old]))
    before = target.read_bytes()
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")}, fetcher=lambda _: spec("ise", path=candidate))
    result = wait(updater, "ise", updater.start("ise"))
    assert result["added"] == 0
    assert result["already_known"] + result["skipped"] == 1
    assert target.read_bytes() == before


def test_unrelated_backup_occupant_causes_failure_not_data_loss(installed):
    target = installed / "ise" / "tools.json"
    backup = target.with_name(target.name + ".api-update-backup.json")
    backup.write_text("operator file")
    before = target.read_bytes()
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")}, fetcher=lambda _: spec("ise"))
    result = wait(updater, "ise", updater.start("ise"))
    assert result["state"] == "failed"
    assert backup.read_text() == "operator file"
    assert target.read_bytes() == before


def test_yaml_local_references_are_resolved_without_a_model(installed):
    import yaml
    raw = yaml.safe_dump(json.loads(spec("ise"))).encode()
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")},
        fetcher=lambda _: raw, extractor=lambda _: pytest.fail("structured input must not call model"))
    result = updater.collect_candidates("ise")
    assert len(result["candidates"]) == 1
    assert result["candidates"][0]["api_details"]["request_body"]["schema"]["required"] == ["policy"]


def test_prose_extraction_requires_literal_method_path_and_input_evidence(installed):
    page = b'<html><main><h1>ISE API Reference</h1><p>POST /ers/config/newWidget</p><p>HTTP Basic authentication required.</p><p>application/json policy enabled boolean required</p></main></html>'
    good = {"name": "createNewWidget", "description": "Create widget", "method": "POST",
        "path": PATHS["ise"], "parameters": [], "request_body": operation()["api_details"]["request_body"],
        "evidence": {"method_path": "POST /ers/config/newWidget", "input_schema": "application/json policy enabled boolean required"},
        "authentication": {"capabilities": ["http:basic"], "evidence": "HTTP Basic authentication required."}}
    updater = updater_class()(user_agents_dir=installed, sources={"ise": {**source("ise"), "security_modes": [["http:basic"]]}}, fetcher=lambda _: page,
        extractor=lambda _: {"operations": [good, {**good, "path": "/ers/config/invented"}]})
    result = updater.collect_candidates("ise")
    assert len(result["candidates"]) == 1
    assert result["skipped"] == 1
    assert any("prose" in warning.lower() for warning in result["warnings"])


@pytest.mark.parametrize("url", ["http://developer.cisco.com/x", "https://user:pass@developer.cisco.com/x", "https://evil.invalid/x", "https://127.0.0.1/x"])
def test_unapproved_reference_url_is_rejected_before_fetch(installed, url):
    config = source("ise")
    config["roots"] = [url]
    updater = updater_class()(user_agents_dir=installed, sources={"ise": config}, fetcher=lambda _: pytest.fail("unsafe URL fetched"))
    result = wait(updater, "ise", updater.start("ise"))
    assert result["state"] == "failed"


def test_pubhub_navigation_resolves_specs_in_published_source_directory(installed):
    config = source("ise")
    config["roots"] = ["https://developer.cisco.com/docs/fixture/"]
    config["allowed_origins"].append("https://pubhub.devnetcloud.com")
    config["reference_prefixes"] = ["https://pubhub.devnetcloud.com/media/fixture/docs/"]
    html = '''<pubhub-content><a href="api.json">Download</a></pubhub-content>
    <script>renderer({webJson:{config:{overview:{markdownPath:"reference/overview.md"}},
    items:[{content:"reference/widget_frame.html",type:"swagger",url:"widgets"}],
    meta:{location:"https://pubhub.devnetcloud.com/media/fixture/docs/"}}})</script>'''
    updater = updater_class()(sources={"ise": config}, user_agents_dir=installed)
    links = updater._links(html, config["roots"][0], config)
    assert "https://pubhub.devnetcloud.com/media/fixture/docs/reference/api.json" in links
    assert "https://pubhub.devnetcloud.com/media/fixture/docs/reference/widget_frame.html" in links
    frame = '<iframe src="widgets.html"></iframe>'
    assert updater._links(frame, "https://pubhub.devnetcloud.com/media/fixture/docs/reference/widget_frame.html", config) == [
        "https://pubhub.devnetcloud.com/media/fixture/docs/reference/widgets.html"]


def test_quoted_pubhub_navigation_retains_relative_spec_links(installed):
    config = {**source("ise"), "roots": ["https://developer.cisco.com/docs/fixture/"],
        "allowed_origins": ["https://developer.cisco.com", "https://pubhub.devnetcloud.com"],
        "reference_prefixes": ["https://pubhub.devnetcloud.com/media/fixture/docs/"]}
    navigation = {"location": "https://pubhub.devnetcloud.com/media/fixture/docs/",
        "overview": {"markdownPath": "reference/overview.md"},
        "items": [{"content": "reference/widget_frame.html", "type": "swagger", "url": "widgets"}]}
    updater = updater_class()(sources={"ise": config}, user_agents_dir=installed)
    links = updater._links("<script>renderer(" + json.dumps(navigation) + ")</script>", config["roots"][0], config)
    assert "https://pubhub.devnetcloud.com/media/fixture/docs/reference/widget_frame.html" in links


def test_markdown_with_fenced_json_falls_through_to_prose_extraction(installed):
    page = b'# Widget\n\nGET /ers/config/newWidget\n\nHTTP Basic authentication required.\n\n```json\n{"sample": true}\n```'
    candidate = {"name": "getWidget", "description": "Get widget", "method": "GET", "path": PATHS["ise"],
        "parameters": [], "request_body": None, "evidence": {"method_path": "GET /ers/config/newWidget", "input_schema": ""},
        "authentication": {"capabilities": ["http:basic"], "evidence": "HTTP Basic authentication required."}}
    updater = updater_class()(user_agents_dir=installed, sources={"ise": {**source("ise"), "security_modes": [["http:basic"]]}},
        fetcher=lambda _: page, extractor=lambda _: {"operations": [candidate]})
    assert len(updater.collect_candidates("ise")["candidates"]) == 1


def test_source_cannot_link_another_product_on_a_shared_official_origin(installed):
    config = source("ise")
    config["roots"] = ["https://developer.cisco.com/docs/fixture/"]
    updater = updater_class()(sources={"ise": config}, user_agents_dir=installed)
    html = '<a href="/docs/cisco-xdr/spec.json">Other product</a>'
    assert updater._links(html, config["roots"][0], config) == []


def test_pubhub_operation_json_is_parsed_without_a_model(installed):
    document = {"type": "api", "title": "Create widget", "meta": {"openapi": "3.0.1",
        "info": {"version": "1"}, "servers": [{"url": "https://example.invalid/ers/config"}]},
        "spec": {"method": "post", "path": "/newWidget", "operationId": "createNewWidget",
            "requestBody": {"content": {"application/json": {"schema": {"type": "object"}}}}}}
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")},
        fetcher=lambda _: json.dumps(document).encode(), extractor=lambda _: pytest.fail("structured data used model"))
    result = updater.collect_candidates("ise")
    assert result["candidates"][0]["endpoint"] == {"method": "POST", "path": "/ers/config/newWidget"}


def test_expired_model_work_never_publishes_later(installed):
    entered, release = threading.Event(), threading.Event()
    page = b'<p>GET /ers/config/newWidget</p>'
    def extract(_):
        entered.set()
        release.wait(2)
        return {"operations": [{"name": "widget", "description": "widget", "method": "GET",
            "path": PATHS["ise"], "parameters": [], "request_body": None,
            "evidence": {"method_path": "GET /ers/config/newWidget", "input_schema": ""}}]}
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")},
        fetcher=lambda _: page, extractor=extract)
    before = (installed / "ise" / "tools.json").read_bytes()
    job = updater.start("ise")
    try:
        assert entered.wait(1)
        updater._deadlines["ise"] = time.monotonic() - 1
        assert updater.status("ise")["state"] == "failed"
        assert updater.start("ise")["state"] == "busy"
    finally:
        release.set()
    updater._worker.join(2)
    assert updater.status("ise", job["job_id"])["state"] == "failed"
    assert (installed / "ise" / "tools.json").read_bytes() == before


def test_server_dispatch_only_accepts_product_and_job_ids(installed, monkeypatch, capsys):
    from ccie_sidecar import server
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")}, fetcher=lambda _: spec("ise"))
    monkeypatch.setattr(server, "_catalog_updater", updater, raising=False)
    result = server.handle_request({"id": "update-1", "method": "agent.catalog_update_start", "params": {"agent_id": "ise"}})
    assert result["type"] == "done", result
    completed = wait(updater, "ise", result["result"])
    response = server.handle_request({"id": "status-1", "method": "agent.catalog_update_status",
        "params": {"agent_id": "ise", "job_id": completed["job_id"]}})
    assert response["result"]["added"] == 1
    for params in ({"agent_id": "ise", "url": "https://evil.invalid"}, {"agent_id": "../ise"}, [], {"agent_id": "ise", "job_id": {}}):
        assert server.handle_request({"id": "bad", "method": "agent.catalog_update_start", "params": params})["type"] == "error"
    assert capsys.readouterr().out == ""


def test_external_or_symlink_catalog_target_is_untouched(installed, tmp_path):
    external = tmp_path / "external.json"
    external.write_text("[]")
    target = installed / "ise" / "tools.json"
    target.unlink()
    target.symlink_to(external)
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")}, fetcher=lambda _: spec("ise"))
    result = wait(updater, "ise", updater.start("ise"))
    assert result["state"] == "failed"
    assert external.read_text() == "[]"


@pytest.mark.parametrize("path", ["https://evil.invalid/x", "//evil.invalid/x", "/ers/config/../admin", "/ers/config/*", "/unrelated/x", "/ers/config/x?token=y"])
def test_untrusted_spec_cannot_expand_transport_or_path_scope(installed, path):
    updater = updater_class()(user_agents_dir=installed, sources={"ise": source("ise")}, fetcher=lambda _: spec("ise", path=path))
    before = (installed / "ise" / "tools.json").read_bytes()
    result = wait(updater, "ise", updater.start("ise"))
    assert result["added"] == 0
    assert result["skipped"] == 1
    assert result["warnings"]
    assert (installed / "ise" / "tools.json").read_bytes() == before
