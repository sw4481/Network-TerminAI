"""The only mutation boundary for the Zabbix specialist."""
import json
from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

class ZabbixApplyInput(BaseModel):
    method: str = Field(description="Approved Zabbix JSON-RPC mutation method")
    params: dict = Field(description="Exact JSON-RPC parameters")
    rationale: str = Field(description="Why this monitoring change is needed")

def build_zabbix_apply_tool():
    def zabbix_apply(method: str, params: dict, rationale: str) -> str:
        from ccie_sidecar.zabbix import ZabbixClient
        from ccie_sidecar.zabbix_config import get_zabbix_config
        return json.dumps(ZabbixClient(get_zabbix_config()).apply(method, params))
    tool = StructuredTool.from_function(zabbix_apply, name="zabbix_apply", description="Apply one reviewed Zabbix monitoring mutation ONLY. Never use this tool for config.get, host.get, item.get, problem.get, history.get, or any other read; use zabbix_api_call for all reads. Allowed methods end in .create, .update, .delete, .mass*, or .acknowledge. Always requires approval.", args_schema=ZabbixApplyInput)
    tool.metadata = {"blast_radius": "high", "requires_approval": True}
    return tool
