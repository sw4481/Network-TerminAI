"""Zabbix-only runtime guardrails."""

from pathlib import Path

from langchain.agents.middleware import ToolCallLimitMiddleware

from ccie_sidecar.agents.deepagents_runtime import _zabbix_runtime_middleware


def test_zabbix_runtime_caps_read_code_calls_but_not_other_agents():
    middleware = _zabbix_runtime_middleware("zabbix")

    assert len(middleware) == 1
    limiter = middleware[0]
    assert isinstance(limiter, ToolCallLimitMiddleware)
    assert limiter.tool_name == "execute_python_code"
    assert limiter.run_limit == 6
    assert limiter.exit_behavior == "continue"

    assert _zabbix_runtime_middleware("meraki") == []
    assert _zabbix_runtime_middleware("network-architect") == []
    assert _zabbix_runtime_middleware(None) == []


def test_zabbix_meraki_workflow_reuses_exact_template_macros():
    prompt = (
        Path(__file__).parents[3] / "bundled-agents" / "zabbix" / "AGENT.md"
    ).read_text()

    for macro in (
        "{$MERAKI.TOKEN}",
        "{$SERIAL}",
        "{$MERAKI.API.URL}",
        "{$MERAKI.HTTP_PROXY}",
        "{$MERAKI.DATA.TIMEOUT}",
    ):
        assert macro in prompt

    assert "Never invent Meraki macro names" in prompt
    assert "start with an exact template.get" in prompt
