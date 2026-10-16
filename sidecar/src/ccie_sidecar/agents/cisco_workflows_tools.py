"""Approval-gated mutation tool for Cisco Workflows (not a sandbox global)."""
from __future__ import annotations

import json
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

from ccie_sidecar.agents.catalog_grounding import CatalogIndex, CatalogGroundingError


class CiscoWorkflowsApplyInput(BaseModel):
    method: str = Field(description="Exact catalog HTTP mutation verb")
    path: str = Field(description="Exact catalog workflow path with concrete IDs")
    body: Any = Field(default=None, description="Complete JSON request body discovered from the operation schema")
    query_params: dict[str, Any] | None = Field(default=None, description="Optional documented query parameters")
    rationale: str = Field(description="Purpose and expected impact of this workflow change")
    organization_id: str = Field(description="Target organization ID shown to the operator; must match the bound and currently configured organization")


def build_cisco_workflows_apply_tool(catalog_index: CatalogIndex | None = None) -> StructuredTool:
    """Build the approval-gated Cisco Workflows mutation tool."""
    from ccie_sidecar.meraki_config import get_meraki_config
    initial_config = get_meraki_config()
    target_org_id = initial_config.get("org_id") if isinstance(initial_config, dict) else None

    def cisco_workflows_apply(
        method: str, path: str, rationale: str, organization_id: str,
        body: Any = None, query_params: dict[str, Any] | None = None,
    ) -> str:
        verb = method.upper() if isinstance(method, str) else ""
        if not isinstance(rationale, str) or not rationale.strip():
            raise ValueError("Approval rationale is required")
        if verb not in {"POST", "PUT", "PATCH", "DELETE"}:
            raise ValueError("Only workflow mutations may use cisco_workflows_apply")
        if (not isinstance(path, str) or
                not path.startswith(("/v1/", "/v1.1/", "/v1.2/", "/exchange/v1/")) or
                "?" in path or "#" in path or "//" in path or
                any(segment in (".", "..") for segment in path.split("/"))):
            raise ValueError("Use one concrete Cisco Workflows catalog path")
        # Share the transport's POST-read classification; catalog discovery does
        # not turn a read/search endpoint into an approved mutation.
        from ccie_sidecar.cisco_workflows import _POST_READS
        if verb == "POST" and path in _POST_READS:
            raise ValueError("Use cisco_workflows_api_call for read operations")
        if not catalog_index or "cisco_workflows" not in catalog_index.catalog_ids:
            raise CatalogGroundingError("Cisco Workflows catalog unavailable; mutation blocked")
        catalog_index.require_authorized("cisco_workflows", verb, path)
        from ccie_sidecar.meraki_config import get_meraki_config
        saved_config = get_meraki_config()
        config = dict(saved_config) if isinstance(saved_config, dict) else None
        if not isinstance(config, dict) or not all(
            isinstance(config.get(key), str) and config[key].strip()
            for key in ("api_key", "org_id")
        ):
            raise ValueError("Settings → Meraki requires both API key and organization ID")
        if (not isinstance(target_org_id, str) or not target_org_id.strip()
                or organization_id != target_org_id or config["org_id"] != target_org_id):
            raise ValueError("Cisco Workflows target organization changed or does not match approval; start a new request")
        from ccie_sidecar.cisco_workflows import CiscoWorkflowsClient
        return json.dumps(
            CiscoWorkflowsClient(config).apply(verb, path, body=body, query_params=query_params),
            ensure_ascii=False,
        )

    tool = StructuredTool.from_function(
        cisco_workflows_apply,
        name="cisco_workflows_apply",
        description=(
            "ONLY approved Cisco Workflows mutation transport. Discover the exact "
            "operation/schema with search_api_catalog first (catalog_id='cisco_workflows'); "
            "submit its method, concrete path, complete JSON body, optional query_params, "
            f"rationale and organization_id={target_org_id!r} for operator approval BEFORE execution. "
            "The organization_id must match this bound target and current Settings; "
            "a changed target requires a new request. Create a complete "
            "workflow with actions/conditions/inputs according to the discovered schema; "
            "do not create an empty name-only record. Discover import/start configuration "
            "and control operations when requested. Never use for reads: POST list/batch_get "
            "are read-only and must use cisco_workflows_api_call. After a create/start "
            "timeout, read saved workflow state or run history before proposing "
            "any retry; never assume the change did not execute."
        ),
        args_schema=CiscoWorkflowsApplyInput,
    )
    tool.metadata = {"blast_radius": "high", "requires_approval": True, "target_org_id": target_org_id}
    return tool
