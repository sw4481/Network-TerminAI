"""Bundled Meraki Workflows agent/catalog contract (no live API calls)."""
import json
from pathlib import Path

import pytest

from ccie_sidecar import agent as agent_loader
from ccie_sidecar.agents.catalog_grounding import CatalogIndex, resolve_agent_catalogs


BUNDLED = Path(__file__).resolve().parents[3] / "bundled-agents" / "cisco-workflows"


def _agent(monkeypatch, tmp_path):
    monkeypatch.setattr(agent_loader, "_agents_dir", lambda: tmp_path / "empty-user-agents")
    return agent_loader.load_agent("cisco-workflows")


def _catalog():
    return json.loads((BUNDLED / "tools.json").read_text(encoding="utf-8"))


def test_manifest_discovers_underscore_helper_and_requires_approval_for_writes(monkeypatch, tmp_path):
    agent = _agent(monkeypatch, tmp_path)
    assert agent is not None
    assert agent["name"] == "cisco-workflows"
    import yaml
    frontmatter = yaml.safe_load((BUNDLED / "AGENT.md").read_text(encoding="utf-8").split("---", 2)[1])
    assert frontmatter["engine"] == "deepagents"
    assert frontmatter["execution-mode"] == "react-code"
    assert agent["attached_tools"][0]["id"] == "cisco_workflows"
    assert agent["attached_tools"][0]["default_blast_radius_allowed"] == "destructive"
    assert "cisco_workflows_api_call(method, path, body=None, query_params=None)" in agent["system_prompt"]
    assert "cisco_workflows_apply" in agent["system_prompt"]
    assert "approval" in agent["system_prompt"].lower()
    assert "api_catalog" in agent["system_prompt"]
    assert "start_config" in agent["system_prompt"]
    assert "request_body.schema_definitions" in agent["system_prompt"]
    assert "multipart" in agent["system_prompt"]
    assert "api.meraki.com/api/automate/organizations/" in agent["system_prompt"]
    assert "OAuth" not in agent["system_prompt"]
    assert "XDR" not in agent["system_prompt"]
    assert len(agent["system_prompt"]) < 4000
    catalogs = resolve_agent_catalogs(agent)
    assert len(catalogs) == 1
    assert catalogs[0]["id"] == "cisco_workflows"
    assert len(catalogs[0]["entries"]) >= 20


@pytest.mark.parametrize("operation_id, method, path", [
    ("getAllWorkflowsPostQueryParams", "POST", "/v1.1/workflows"),
    ("getAllWorkflowsPostQueryParamsV1Dot2", "POST", "/v1.2/workflows"),
    ("workflowCreateRequest", "POST", "/v1/workflows"),
    ("getWorkflowById", "GET", "/v1/workflows/{workflow_id}"),
    ("workflowUpdateRequest", "PUT", "/v1/workflows/{workflow_id}"),
    ("addActionRequest", "POST", "/v1/workflows/{workflow_id}/actions"),
    ("actionUpdateRequest", "PUT", "/v1/workflows/{workflow_id}/actions/{action_id}"),
    ("importFromJSONReq", "POST", "/exchange/v1/workflows/import"),
    ("workflowInputParams", "GET", "/v1/workflows/start_config"),
    ("startWorkflowRequest", "POST", "/v1/workflows/start"),
    ("getWFInstanceById", "GET", "/v1/instances/{wf_instance_id}"),
    ("getAllWorkflowInstancesQueryParams", "POST", "/v1.1/instances"),
    ("workflowBatchGetPostRequest", "POST", "/v1/workflows/batch_get"),
    ("getAllSchemaQueryParams", "GET", "/v1/schemas"),
    ("getSchemaById", "GET", "/v1/schemas/{type_or_id}"),
    ("getAllRulesQueryParam", "POST", "/v1/rules/batch_get"),
    ("getAllVarTypesRequest", "POST", "/v1/variable_types/batch_get"),
    ("exportToJSONReq", "GET", "/exchange/v1/workflows/export"),
])
def test_authoritative_operation_is_searchable_and_authorized(operation_id, method, path):
    index = CatalogIndex([{"id": "cisco_workflows", "entries": _catalog()}])
    result = index.search(operation_id, catalog_id="cisco_workflows", limit=1)
    match = result["matches"][0]
    assert match["method"] == method
    assert match["path"] == path
    assert match["allowed"] is True
    index.require_authorized("cisco_workflows", method, path.replace("{workflow_id}", "wf_1").replace("{action_id}", "act_1").replace("{wf_instance_id}", "run_1").replace("{type_or_id}", "schema_1"))


def test_create_and_action_search_expose_real_request_body_fields_and_refs():
    index = CatalogIndex([{"id": "cisco_workflows", "entries": _catalog()}])
    create = index.search("workflowCreateRequest", catalog_id="cisco_workflows", limit=1)["matches"][0]
    assert create["parameters"]["required"] == ["name", "properties"]
    assert create["parameters"]["fields"]["variables"]["type"] == "array"
    assert "workflowDefinitionPostRequest" in create["summary"]
    assert "Variable.schema_id" in create["summary"]
    action = index.search("addActionRequest", catalog_id="cisco_workflows", limit=1)["matches"][0]
    assert action["parameters"]["fields"]["action"]["type"] == "object"
    assert "ActionDefinitionPostRequest.properties" in action["summary"]
    assert "previous_action" in action["summary"]


def test_import_start_status_and_batch_read_search_preserves_payload_shapes():
    index = CatalogIndex([{"id": "cisco_workflows", "entries": _catalog()}])
    imported = index.search("importFromJSONReq", catalog_id="cisco_workflows", limit=1)["matches"][0]
    assert "ImportExport_WFExportObjects" in imported["summary"]
    assert "GET workflow definition" in imported["summary"]
    assert "workflow" in imported["parameters"]["fields"]
    assert imported["parameters"]["fields"]["subworkflows"]["type"] == "array"
    start = index.search("startWorkflowRequest", catalog_id="cisco_workflows", limit=1)["matches"][0]
    assert start["parameters"]["fields"]["input_variables"]["type"] == "array"
    assert "VariableStartPutRequest.properties" in start["summary"]
    assert "workflow_id" in start["parameters"]["fields"]
    assert "unique_name" in start["parameters"]["fields"]
    assert "StartWorkflowResponse" in start["summary"]
    config = index.search("workflowInputParams", catalog_id="cisco_workflows", limit=1)["matches"][0]
    assert "StartWorklfowConfigResponse" in config["summary"]
    assert "input_variables" in config["summary"]
    history = index.search("getAllWorkflowInstancesQueryParams", catalog_id="cisco_workflows", limit=1)["matches"][0]
    assert {"limit", "date_from"}.issubset(history["parameters"]["required"])
    assert history["parameters"]["fields"]["date_from"]["type"] == "string"
    batch = CatalogIndex([{"id": "cisco_workflows", "entries": _catalog()}]).search(
        "workflowBatchGetPostRequest", catalog_id="cisco_workflows", limit=1
    )["matches"][0]
    assert "array<string>" in batch["summary"]
    assert batch["parameters"]["fields"]["body"]["type"] == "array"
    status = CatalogIndex([{"id": "cisco_workflows", "entries": _catalog()}]).search(
        "getWFInstanceById", catalog_id="cisco_workflows", limit=1
    )["matches"][0]
    assert "status:Status.state" in status["summary"]
    assert "actions:array<ActionInstanceGetAllResponse>" in status["summary"]


def test_native_search_leaves_non_http_and_schema_less_matches_unchanged():
    from langchain_core.tools import StructuredTool
    from ccie_sidecar.agents.deepagents_tools import create_catalog_search_tool

    tool = StructuredTool.from_function(lambda code: "", name="execute_python_code", description="Sandbox")
    object.__setattr__(tool, "_ccie_catalog_index", CatalogIndex([{
        "id": "cisco_workflows", "entries": [
            {"name": "localUtility", "description": "local utility"},
            {"name": "readStatus", "endpoint": {"method": "GET", "path": "/v1/status"}},
        ],
    }]))
    search = create_catalog_search_tool(tool)
    assert search is not None
    non_http = search.invoke({"query": "localUtility", "catalog_id": "cisco_workflows", "limit": 1})
    assert len(non_http["matches"]) == 1
    assert non_http["matches"][0]["name"].startswith("localUtility")
    assert "helper" not in non_http["matches"][0] and "request_body" not in non_http["matches"][0]
    http = search.invoke({"query": "readStatus", "catalog_id": "cisco_workflows", "limit": 1})
    assert len(http["matches"]) == 1
    assert http["matches"][0]["helper"] == "cisco_workflows_api_call"
    assert http["matches"][0]["path"] == "/v1/status"
    assert "name" not in http["matches"][0] and "request_body" not in http["matches"][0]


def test_native_search_exposes_resolved_json_body_schemas_without_guessing():
    from langchain_core.tools import StructuredTool
    from ccie_sidecar.agents.deepagents_tools import create_catalog_search_tool

    tool = StructuredTool.from_function(
        func=lambda code: "", name="execute_python_code", description="Sandbox",
    )
    object.__setattr__(tool, "_ccie_catalog_index", CatalogIndex([{
        "id": "cisco_workflows", "entries": _catalog(),
    }]))
    search = create_catalog_search_tool(tool)
    assert search is not None
    for operation_id, schema_name, field, field_schema in (
        ("workflowCreateRequest", "workflowDefinitionPostRequest", "variables", "Variable"),
        ("addActionRequest", "AddActionPostRequest", "action", "ActionDefinitionPostRequest"),
        ("importFromJSONReq", "ImportExport_WFExportObjects", "workflow", "ImportExport_WorkflowDefExport"),
        ("startWorkflowRequest", "startWorklfowPostRequestPayload", "input_variables", "VariableStartPutRequest"),
    ):
        # A real HTTP helper call resets this budget between distinct discoveries;
        # this isolated tool test only needs four schema-bearing matches.
        match = search.invoke({
            "query": operation_id, "catalog_id": "cisco_workflows", "limit": 1,
        })["matches"][0]
        assert match["helper"] == "cisco_workflows_api_call" and "name" not in match
        body = match["request_body"]
        assert body["content_type"] == "application/json"
        assert body["schema_ref"] == schema_name
        assert field in body["schema"]["properties"]
        nested = body["schema"]["properties"][field]
        if nested.get("type") == "array":
            nested = nested["items"]
        assert nested["$ref"].endswith("/" + field_schema)
        definitions = body["schema_definitions"]
        component = definitions[field_schema]
        assert isinstance(component["properties"], dict) and component["properties"]
        assert isinstance(component.get("required", []), list)
        if field_schema == "Variable":
            assert "schema_id" in component["required"]
            assert "value" in definitions["VariableContent"]["properties"]
        if field_schema == "ActionDefinitionPostRequest":
            assert component["properties"]["properties"]["type"] == "object"
        if field_schema == "ImportExport_WorkflowDefExport":
            assert "actions" in component["properties"]
            assert "ImportExport_ActionDefExport" in definitions
        if field_schema == "VariableStartPutRequest":
            assert "value" in definitions["VariableContent"]["properties"]


def test_catalog_sources_are_published_oas_and_multipart_is_not_available():
    entries = _catalog()
    assert all(entry["source"]["openapi"] == "3.0.1" for entry in entries)
    assert all(entry["source"]["version"] == "1.0.0" for entry in entries)
    assert all(entry["source"]["operation_id"] for entry in entries)
    assert len({(e["endpoint"]["method"], e["endpoint"]["path"]) for e in entries}) == len(entries)
    assert not any(e["endpoint"]["path"] == "/v1.1/workflows/start" for e in entries)
    assert all(e.get("request_body", {}).get("content_type") != "multipart/form-data" for e in entries)
    assert all(not e["endpoint"]["path"].startswith("/v1/metadata/refreshtoken") for e in entries)
