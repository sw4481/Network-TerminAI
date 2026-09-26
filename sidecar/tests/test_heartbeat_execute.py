"""Tests for heartbeat check execution."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ccie_sidecar.agents.heartbeat_executor import (
    _HEARTBEAT_EFFICIENCY_DIRECTIVE,
    _MERAKI_HEARTBEAT_GUIDANCE,
    _PYATS_HEARTBEAT_GUIDANCE,
    MERAKI_HEARTBEAT_CATALOG_QUERY,
    _execute_agent,
    _parse_agent_output,
    execute_check,
    _parse_pyats_output,
    _parse_meraki_output,
    _parse_stealthwatch_output,
    _parse_ise_output,
    _parse_cml_output,
    _parse_catalyst_center_output,
    _parse_generic_output,
)


def test_meraki_heartbeat_guidance_uses_one_grounded_network_scoped_recipe():
    guidance = _MERAKI_HEARTBEAT_GUIDANCE

    assert MERAKI_HEARTBEAT_CATALOG_QUERY in guidance
    assert "TOP-LEVEL search_api_catalog" in guidance
    assert 'catalog_id="meraki"' in guidance
    assert '"networkIds": [network_id]' in guidance
    assert '"networkId": network_id' in guidance
    assert '"active": True' in guidance
    assert "do not explore first" not in guidance.lower()
    assert "Never request organization-wide device statuses or alerts" in guidance


def test_pyats_heartbeat_guidance_uses_grounded_current_verbs():
    guidance = _PYATS_HEARTBEAT_GUIDANCE

    assert "TOP-LEVEL search_api_catalog" in guidance
    assert 'catalog_id="pyats"' in guidance
    assert "pyats.call(\"list-devices\")" in guidance
    assert 'names = [d["name"] for d in env["data"]]' in guidance
    assert "pyats.call(\"run-show-command\"" in guidance
    assert "from pyats import call" not in guidance


class TestExecuteCheck:
    """Test the main execute_check function."""

    def test_agent_not_found(self):
        """Test handling when agent doesn't exist."""
        result = execute_check("nonexistent-agent", "Check status", "check-001")

        assert "findings" in result
        assert len(result["findings"]) == 1
        finding = result["findings"][0]
        assert finding["severity"] == "error"
        assert "not found" in finding["title"].lower()
        assert finding["metadata"]["agent_id"] == "nonexistent-agent"

    @patch("ccie_sidecar.agent.get_saved_config")
    @patch("ccie_sidecar.agent.load_agent")
    def test_agent_no_tools(self, mock_load, mock_config):
        """Test handling when agent has no attached tools."""
        # execute_check checks for a configured LLM provider before the tools
        # check; stub it so this test exercises the no-tools path regardless of
        # whether an LLM provider is configured in the environment (e.g. CI).
        mock_config.return_value = {"provider": "anthropic", "api_key": "test"}
        mock_load.return_value = {
            "id": "test-agent",
            "system_prompt": "Test prompt",
            "attached_tools": []
        }

        result = execute_check("test-agent", "Check status", "check-002")

        assert "findings" in result
        assert len(result["findings"]) == 1
        finding = result["findings"][0]
        assert finding["severity"] == "error"
        assert "no attached tools" in finding["message"]

    @patch("ccie_sidecar.agent.load_agent")
    @patch("ccie_sidecar.agents.heartbeat_executor.asyncio.run")
    def test_successful_execution_no_issues(self, mock_asyncio_run, mock_load):
        """Test successful check with no issues found (empty findings = OK)."""
        mock_load.return_value = {
            "id": "test-agent",
            "system_prompt": "Test prompt",
            "attached_tools": [{"id": "test-tool"}]
        }

        # Close the coroutine because the mocked asyncio.run will not await it.
        def fake_run(coro):
            coro.close()
            return {"findings": []}

        mock_asyncio_run.side_effect = fake_run

        result = execute_check("test-agent", "Check status", "check-003")

        assert "findings" in result
        assert len(result["findings"]) == 0  # Empty = OK

    @patch("ccie_sidecar.agent.load_agent")
    @patch("ccie_sidecar.agents.heartbeat_executor.asyncio.run")
    def test_execution_timeout(self, mock_asyncio_run, mock_load):
        """Test handling of agent execution timeout."""
        mock_load.return_value = {
            "id": "test-agent",
            "system_prompt": "Test prompt",
            "attached_tools": [{"id": "test-tool"}]
        }

        # Mock asyncio.run as if _run_agent_with_timeout caught the timeout.
        # Close the coroutine because this mock does not await it.
        def fake_run(coro):
            coro.close()
            return {
                "findings": [
                    {
                        "severity": "error",
                        "title": "Check execution timeout",
                        "message": "The agent 'test-agent' did not complete within 120 seconds.",
                        "metadata": {"check_id": "check-004", "agent_id": "test-agent", "timeout_seconds": 120}
                    }
                ]
            }

        mock_asyncio_run.side_effect = fake_run

        result = execute_check("test-agent", "Check status", "check-004")

        assert "findings" in result
        assert len(result["findings"]) == 1
        finding = result["findings"][0]
        assert finding["severity"] == "error"
        assert "timeout" in finding["title"].lower()


class TestParsePyatsOutput:
    """Test pyATS output parsing."""

    def test_parse_successful_tests(self):
        """Test parsing output with all tests passed."""
        text = """
        Device health check complete.
        All tests passed successfully.
        Interface status: OK
        Routing protocols: Healthy
        """
        findings = _parse_pyats_output(text, "check-001")
        assert len(findings) == 0  # No issues = OK

    def test_parse_failed_tests(self):
        """Test parsing output with failed tests."""
        text = """
        Device health check results:
        Test BGP neighbors: FAILED
        Test OSPF adjacencies: FAILED
        Interface status: OK
        """
        findings = _parse_pyats_output(text, "check-002")
        assert len(findings) > 0
        assert any(f["severity"] == "error" for f in findings)
        assert any("fail" in f["title"].lower() for f in findings)

    def test_parse_unreachable_device(self):
        """Test parsing output with unreachable device."""
        text = """
        Attempting to connect to R1...
        Error: Device R1 is unreachable.
        Connection refused on 192.168.1.1:22
        """
        findings = _parse_pyats_output(text, "check-003")
        assert len(findings) > 0
        assert any(f["severity"] == "critical" for f in findings)
        assert any("unreachable" in f["title"].lower() for f in findings)

    def test_parse_interface_down(self):
        """Test parsing output with interface down."""
        text = """
        Interface GigabitEthernet1/0/1: down/down
        Interface GigabitEthernet1/0/2: up/up
        """
        findings = _parse_pyats_output(text, "check-004")
        assert len(findings) > 0
        assert any(f["severity"] == "warning" for f in findings)
        assert any("interface" in f["title"].lower() for f in findings)

    def test_parse_no_failures_negation(self):
        """Test that 'no failures' output doesn't trigger false positives."""
        text = """
        No anomalies or failures were detected on the only configured device (SW1).
        The device is reachable, all interfaces are up, and both OSPF and BGP
        (if present) show healthy neighbor/peer states.
        """
        findings = _parse_pyats_output(text, "check-005")
        # Should have NO findings because the text says "no failures"
        assert len(findings) == 0

    def test_parse_real_failure_detected(self):
        """Test that real failures are still detected after negation fix."""
        text = """
        Test run completed.
        BGP neighbor check: FAILED - neighbor 192.168.1.1 not established
        Total: 1 failed, 3 passed
        """
        findings = _parse_pyats_output(text, "check-006")
        assert len(findings) > 0
        assert any(f["severity"] == "error" for f in findings)
        assert any("fail" in f["message"].lower() for f in findings)

    def test_parse_zero_failures(self):
        """Test '0 failures' negation pattern."""
        text = """
        Test suite completed successfully.
        0 failed tests, 15 passed tests
        All checks completed without errors.
        """
        findings = _parse_pyats_output(text, "check-007")
        assert len(findings) == 0


class TestParseMerakiOutput:
    """Test Meraki output parsing."""

    def test_parse_all_online(self):
        """Test parsing with all devices online."""
        text = """
        Meraki network status:
        10 devices online
        No alerts
        All systems operational
        """
        findings = _parse_meraki_output(text, "check-001")
        assert len(findings) == 0  # No issues

    def test_parse_offline_devices(self):
        """Test parsing with offline devices."""
        text = """
        Network devices:
        - AP-01: online
        - AP-02: offline
        - SW-01: online
        """
        findings = _parse_meraki_output(text, "check-002")
        assert len(findings) > 0
        assert any(f["severity"] == "error" for f in findings)
        assert any("offline" in f["title"].lower() for f in findings)

    def test_parse_critical_alerts(self):
        """Test parsing with critical alerts."""
        text = """
        Dashboard alerts:
        - Critical alert: Switch port flapping on SW-01
        - Warning alert: High bandwidth usage
        """
        findings = _parse_meraki_output(text, "check-003")
        assert len(findings) > 0
        assert any(f["severity"] == "critical" for f in findings)
        assert any("alert" in f["title"].lower() for f in findings)

    def test_parse_connectivity_issues(self):
        """Test parsing with connectivity problems."""
        text = """
        Network health check:
        Connectivity issues detected on AP-05
        Unable to reach upstream gateway
        """
        findings = _parse_meraki_output(text, "check-004")
        assert len(findings) > 0
        assert any(f["severity"] == "error" for f in findings)
        assert any("connectivity" in f["title"].lower() for f in findings)


class TestParseStealthwatchOutput:
    """Test Stealthwatch output parsing."""

    def test_parse_no_threats(self):
        """Test parsing with no security threats."""
        text = """
        Security analysis complete.
        No high-severity alerts.
        Network baseline normal.
        """
        findings = _parse_stealthwatch_output(text, "check-001")
        assert len(findings) == 0

    def test_parse_high_severity_alerts(self):
        """Test parsing with high-severity alerts."""
        text = """
        Security alerts:
        - High severity: Possible data exfiltration detected
        - Medium severity: Port scan from internal host
        """
        findings = _parse_stealthwatch_output(text, "check-002")
        assert len(findings) > 0
        assert any(f["severity"] == "critical" for f in findings)

    def test_parse_threats(self):
        """Test parsing with security threats."""
        text = """
        Threat analysis:
        Malicious traffic pattern detected from 10.1.1.50
        Potential command-and-control activity
        """
        findings = _parse_stealthwatch_output(text, "check-003")
        assert len(findings) > 0
        assert any(f["severity"] == "error" for f in findings)
        assert any("threat" in f["title"].lower() for f in findings)

    def test_parse_anomalies(self):
        """Test parsing with anomalous behavior."""
        text = """
        Flow analysis:
        Unusual traffic patterns on subnet 10.2.0.0/24
        Anomalous connection count from host 10.2.1.100
        """
        findings = _parse_stealthwatch_output(text, "check-004")
        assert len(findings) > 0
        assert any(f["severity"] == "warning" for f in findings)


class TestParseIseOutput:
    """Test ISE output parsing."""

    def test_parse_all_healthy(self):
        """Test parsing with all services healthy."""
        text = """
        ISE health check:
        All services running
        No authentication failures in last hour
        Policy compliance: 100%
        """
        findings = _parse_ise_output(text, "check-001")
        assert len(findings) == 0

    def test_parse_failed_authentications(self):
        """Test parsing with authentication failures."""
        text = """
        Authentication summary:
        45 failed authentications in last hour
        Top failure reasons: Invalid credentials
        """
        findings = _parse_ise_output(text, "check-002")
        assert len(findings) > 0
        assert any(f["severity"] == "error" for f in findings)
        assert any("auth" in f["title"].lower() for f in findings)

    def test_parse_policy_violations(self):
        """Test parsing with policy violations."""
        text = """
        Endpoint compliance:
        5 non-compliant endpoints detected
        Policy violations: Antivirus not running
        """
        findings = _parse_ise_output(text, "check-003")
        assert len(findings) > 0
        assert any(f["severity"] == "warning" for f in findings)
        assert any("policy" in f["title"].lower() for f in findings)

    def test_parse_service_down(self):
        """Test parsing with service issues."""
        text = """
        Service status:
        - Authentication service: up
        - Profiling service: down
        - Policy service: unavailable
        """
        findings = _parse_ise_output(text, "check-004")
        assert len(findings) > 0
        assert any(f["severity"] == "critical" for f in findings)


class TestParseCmlOutput:
    """Test CML output parsing."""

    def test_parse_all_running(self):
        """Test parsing with all labs running."""
        text = """
        CML lab status:
        All labs running normally
        Resource utilization: 45%
        No node failures
        """
        findings = _parse_cml_output(text, "check-001")
        assert len(findings) == 0

    def test_parse_stopped_labs(self):
        """Test parsing with stopped labs."""
        text = """
        Lab inventory:
        - CCIE Lab: running
        - CCNP Lab: stopped
        - Test Lab: not running
        """
        findings = _parse_cml_output(text, "check-002")
        assert len(findings) > 0
        assert any(f["severity"] == "warning" for f in findings)
        assert any("stopped" in f["title"].lower() for f in findings)

    def test_parse_node_failures(self):
        """Test parsing with node failures."""
        text = """
        Simulation status:
        Node R1: running
        Node R2: failed node startup
        Node SW1: running
        """
        findings = _parse_cml_output(text, "check-003")
        assert len(findings) > 0
        assert any(f["severity"] == "error" for f in findings)
        assert any("node" in f["title"].lower() for f in findings)

    def test_parse_resource_constraints(self):
        """Test parsing with resource issues."""
        text = """
        System resources:
        CPU: 95%
        Memory: Resource limit reached
        Storage: 85%
        """
        findings = _parse_cml_output(text, "check-004")
        assert len(findings) > 0
        assert any(f["severity"] == "warning" for f in findings)


class TestParseCatalystCenterOutput:
    """Test Catalyst Center output parsing."""

    def test_parse_all_healthy(self):
        """Test parsing with all systems healthy."""
        text = """
        Network assurance summary:
        All devices healthy
        Client health score: 98%
        No critical issues
        """
        findings = _parse_catalyst_center_output(text, "check-001")
        assert len(findings) == 0

    def test_parse_critical_issues(self):
        """Test parsing with critical issues."""
        text = """
        Assurance issues:
        - Critical issue: Core switch unreachable
        - Severity: critical - WLC licensing expired
        """
        findings = _parse_catalyst_center_output(text, "check-002")
        assert len(findings) > 0
        assert any(f["severity"] == "critical" for f in findings)

    def test_parse_poor_device_health(self):
        """Test parsing with poor device health."""
        text = """
        Device health scores:
        - SW-CORE-01: 35% (Poor device health)
        - SW-ACCESS-02: 45% (Critical)
        """
        findings = _parse_catalyst_center_output(text, "check-003")
        assert len(findings) > 0
        assert any(f["severity"] == "error" for f in findings)
        assert any("health" in f["title"].lower() for f in findings)

    def test_parse_client_issues(self):
        """Test parsing with client connectivity problems."""
        text = """
        Client connectivity:
        10 clients experiencing connection issues
        Problem: DHCP timeout
        """
        findings = _parse_catalyst_center_output(text, "check-004")
        assert len(findings) > 0
        assert any(f["severity"] == "warning" for f in findings)
        assert any("client" in f["title"].lower() for f in findings)


class TestParseGenericOutput:
    """Test generic output parser."""

    def test_parse_critical_mention(self):
        """Test parsing with 'critical' keyword."""
        text = "System check: Critical issues detected in module A"
        findings = _parse_generic_output(text, "check-001", "custom-agent")
        assert len(findings) > 0
        assert any(f["severity"] == "critical" for f in findings)

    def test_parse_error_mention(self):
        """Test parsing with 'error' keyword."""
        text = "Status check: Error in service initialization"
        findings = _parse_generic_output(text, "check-002", "custom-agent")
        assert len(findings) > 0
        assert any(f["severity"] == "error" for f in findings)

    def test_parse_warning_mention(self):
        """Test parsing with 'warning' keyword."""
        text = "Health check: Warning - disk space low"
        findings = _parse_generic_output(text, "check-003", "custom-agent")
        assert len(findings) > 0
        assert any(f["severity"] == "warning" for f in findings)

    def test_parse_no_issues(self):
        """Test parsing with no severity keywords."""
        text = "System status: All services operational"
        findings = _parse_generic_output(text, "check-004", "custom-agent")
        assert len(findings) == 0


class TestEdgeCases:
    """Test edge cases and error handling."""

    def test_empty_output(self):
        """Test handling of empty agent output."""
        findings = _parse_pyats_output("", "check-001")
        # Empty output is handled upstream, but parser should be safe
        assert isinstance(findings, list)

    def test_very_long_output(self):
        """Test handling of very long output."""
        long_text = "Test line\n" * 10000
        findings = _parse_meraki_output(long_text, "check-002")
        # Should still parse without crashing
        assert isinstance(findings, list)

    def test_unicode_in_output(self):
        """Test handling of unicode characters."""
        text = "Device status: ✓ All systems operational 🎉"
        findings = _parse_generic_output(text, "check-003", "test-agent")
        assert isinstance(findings, list)

    def test_multiple_severity_keywords(self):
        """Test output with multiple severity indicators."""
        text = """
        System check:
        Critical error in module A
        Warning in module B
        Failed test in module C
        """
        findings = _parse_generic_output(text, "check-004", "test-agent")
        # Should pick the highest severity
        assert len(findings) > 0
        assert any(f["severity"] == "critical" for f in findings)


class TestHeartbeatExecutionOutcomes:
    """Heartbeat findings must distinguish final, degraded, and failed runs."""

    @pytest.mark.asyncio
    async def test_heartbeat_explicitly_opts_into_recovery_policy(self, monkeypatch):
        monkeypatch.delenv("CCIE_MODEL_PROTOCOL_RECOVERY", raising=False)
        run_outcome = {
            "final_emitted": False,
            "steps": 0,
            "error_kind": None,
            "error_type": None,
            "recovery_attempts": 0,
            "fallback_mode": None,
        }
        loop = AsyncMock(return_value=run_outcome)
        agent = {
            "id": "pyats",
            "system_prompt": "Check the lab.",
            "attached_tools": [{"id": "pyats"}],
        }

        with (
            patch(
                "ccie_sidecar.agent.get_saved_config",
                return_value={"provider": "test"},
            ),
            patch(
                "ccie_sidecar.agents.deepagents_runtime.deepagents_react_code_loop",
                loop,
            ),
        ):
            await _execute_agent(
                agent=agent,
                agent_id="pyats",
                prompt="Check device health",
                check_id="check-policy",
            )

        policy = loop.await_args.kwargs["execution_policy"]
        assert policy.protocol_recovery_enabled is True

    @pytest.mark.asyncio
    async def test_meraki_heartbeat_uses_compact_focused_agent_contract(self):
        run_outcome = {
            "final_emitted": False,
            "steps": 0,
            "error_kind": None,
            "error_type": None,
            "recovery_attempts": 0,
            "fallback_mode": None,
        }
        loop = AsyncMock(return_value=run_outcome)
        agent = {
            "id": "meraki",
            "system_prompt": "INTERACTIVE-MERAKI-PROMPT-SENTINEL " * 2_000,
            "attached_tools": [{"id": "meraki"}],
        }

        with (
            patch(
                "ccie_sidecar.agent.get_saved_config",
                return_value={"provider": "test"},
            ),
            patch(
                "ccie_sidecar.meraki_config.get_meraki_config",
                return_value={"api_key": "test-key"},
            ),
            patch(
                "ccie_sidecar.agents.deepagents_runtime.deepagents_react_code_loop",
                loop,
            ),
        ):
            await _execute_agent(
                agent=agent,
                agent_id="meraki",
                prompt="Check Example-Branch",
                check_id="check-focused",
            )

        agent_def = loop.await_args.kwargs["agent_def"]
        assert agent_def["focused_api_mode"] is True
        assert "INTERACTIVE-MERAKI-PROMPT-SENTINEL" not in agent_def["system_prompt"]
        assert MERAKI_HEARTBEAT_CATALOG_QUERY in agent_def["system_prompt"]
        assert len(agent_def["system_prompt"]) < 6_000

    def test_normal_final_preserves_recovery_telemetry(self):
        outcome = {
            "final_emitted": True,
            "steps": 2,
            "error_kind": None,
            "error_type": None,
            "recovery_attempts": 1,
            "fallback_mode": "non_streaming_model_call",
        }

        findings = _parse_agent_output(
            "meraki",
            [{"type": "final", "response": "All 3 devices are online. No alerts."}],
            "check-final",
            outcome=outcome,
        )

        assert findings[0]["severity"] == "ok"
        assert findings[0]["metadata"]["kind"] == "summary"
        assert findings[0]["metadata"]["degraded"] is False
        assert findings[0]["metadata"]["recovery_attempts"] == 1
        assert findings[0]["metadata"]["fallback_mode"] == "non_streaming_model_call"

    def test_tool_data_without_final_is_explicitly_degraded(self):
        outcome = {
            "final_emitted": False,
            "steps": 1,
            "error_kind": None,
            "error_type": None,
            "recovery_attempts": 0,
            "fallback_mode": None,
        }

        findings = _parse_agent_output(
            "pyats",
            [
                {
                    "type": "tool_result",
                    "name": "execute_python_code",
                    "success": True,
                    "result": "SW1 reachable; interfaces healthy",
                }
            ],
            "check-fallback",
            outcome=outcome,
        )

        assert findings[0]["severity"] == "info"
        assert findings[0]["metadata"]["kind"] == "tool_fallback"
        assert findings[0]["metadata"]["degraded"] is True
        assert "Raw tool results" in findings[0]["message"]

    @pytest.mark.parametrize(
        ("tool_name", "result"),
        [
            ("write_todos", "Updated todo list"),
            ("GraderResponse", "✓ Grading passed"),
            ("read_file", "virtual filesystem content"),
            ("unknown", "unattributed result"),
        ],
    )
    def test_non_data_tool_success_is_not_a_degraded_health_result(
        self,
        tool_name,
        result,
    ):
        findings = _parse_agent_output(
            "meraki",
            [
                {
                    "type": "tool_result",
                    "name": tool_name,
                    "success": True,
                    "result": result,
                }
            ],
            "check-provenance",
            outcome={
                "final_emitted": False,
                "steps": 1,
                "error_kind": None,
                "error_type": None,
                "recovery_attempts": 0,
                "fallback_mode": None,
            },
        )

        assert findings[0]["severity"] == "error"
        assert findings[0]["metadata"]["kind"] == "empty_final"

    def test_execute_python_error_text_is_not_degraded_data(self):
        findings = _parse_agent_output(
            "meraki",
            [
                {
                    "type": "tool_result",
                    "name": "execute_python_code",
                    "success": True,
                    "result": "Error: API request failed",
                }
            ],
            "check-tool-error",
            outcome={
                "final_emitted": False,
                "steps": 1,
                "error_kind": None,
                "error_type": None,
                "recovery_attempts": 0,
                "fallback_mode": None,
            },
        )

        assert findings[0]["metadata"]["kind"] == "empty_final"

    def test_execute_python_no_output_sentinel_is_empty_final(self):
        findings = _parse_agent_output(
            "meraki",
            [
                {
                    "type": "tool_result",
                    "name": "execute_python_code",
                    "success": True,
                    "result": "(no output)",
                }
            ],
            "check-no-output",
            outcome={
                "final_emitted": False,
                "steps": 1,
                "error_kind": None,
                "error_type": None,
                "recovery_attempts": 0,
                "fallback_mode": None,
            },
        )

        assert findings[0]["severity"] == "error"
        assert findings[0]["metadata"]["kind"] == "empty_final"

    def test_runtime_error_cannot_be_reported_as_clean_final(self):
        outcome = {
            "final_emitted": True,
            "steps": 3,
            "error_kind": "model_protocol",
            "error_type": "APIError",
            "recovery_attempts": 1,
            "fallback_mode": "non_streaming_model_call",
        }

        findings = _parse_agent_output(
            "meraki",
            [
                {"type": "final", "response": "Partial answer"},
                {
                    "type": "error",
                    "message": "DeepAgents runtime error: APIError: Unknown role: final",
                    "kind": "model_protocol",
                    "error_type": "APIError",
                },
            ],
            "check-error",
            outcome=outcome,
        )

        assert len(findings) == 1
        assert findings[0]["severity"] == "error"
        assert findings[0]["title"] == "Model response protocol error"
        assert findings[0]["metadata"]["error_kind"] == "model_protocol"
        assert findings[0]["metadata"]["degraded"] is False

    @pytest.mark.parametrize(
        ("error_kind", "expected_title"),
        [
            ("model_protocol", "Model response protocol error"),
            ("authentication", "Model authentication error"),
            ("configuration", "Model configuration error"),
            ("client_error", "Model request rejected"),
            ("rate_limit", "Model rate limit reached"),
            ("context_overflow", "Model context limit exceeded"),
            ("timeout", "Model request timeout"),
            ("tool", "Agent tool error"),
            ("step_limit", "Agent step limit reached"),
            ("runtime", "Agent runtime error"),
        ],
    )
    def test_failed_recovery_title_uses_final_error_category(
        self,
        error_kind,
        expected_title,
    ):
        findings = _parse_agent_output(
            "meraki",
            [
                {
                    "type": "error",
                    "message": "Recovery failed",
                    "kind": error_kind,
                    "error_type": "FinalError",
                    "initial_error_type": "ProtocolError",
                    "fallback_error_type": "FinalError",
                }
            ],
            "check-category",
            outcome={
                "final_emitted": False,
                "steps": 0,
                "error_kind": error_kind,
                "error_type": "FinalError",
                "recovery_attempts": 1,
                "fallback_mode": "non_streaming_model_call",
            },
        )

        assert findings[0]["title"] == expected_title
        assert findings[0]["metadata"]["error_kind"] == error_kind
        assert findings[0]["metadata"]["initial_error_type"] == "ProtocolError"
        assert findings[0]["metadata"]["fallback_error_type"] == "FinalError"

    def test_no_final_or_tool_data_is_empty_final_error(self):
        findings = _parse_agent_output(
            "meraki",
            [],
            "check-empty",
            outcome={
                "final_emitted": False,
                "steps": 0,
                "error_kind": None,
                "error_type": None,
                "recovery_attempts": 0,
                "fallback_mode": None,
            },
        )

        assert findings[0]["severity"] == "error"
        assert findings[0]["metadata"]["kind"] == "empty_final"
        assert findings[0]["metadata"]["error_kind"] == "empty_final"

    def test_large_virtual_result_guidance_uses_builtin_read_file(self):
        assert "/large_tool_results/..." in _HEARTBEAT_EFFICIENCY_DIRECTIVE
        assert "built-in `read_file`" in _HEARTBEAT_EFFICIENCY_DIRECTIVE
        assert "cannot be" in _HEARTBEAT_EFFICIENCY_DIRECTIVE
        assert "execute_python_code" in _HEARTBEAT_EFFICIENCY_DIRECTIVE

    def test_summarized_stdout_guidance_uses_sandbox_local_tool_output(self):
        directive = _HEARTBEAT_EFFICIENCY_DIRECTIVE
        assert "sandbox-local `tool_output`" in directive
        assert "tool_output.stats()" in directive
        assert "tool_output.head()" in directive
        assert "tool_output.tail()" in directive
        assert "tool_output.grep(...)" in directive
        assert "tool_output.json()" in directive
        assert "latest stdout" in directive
        assert "NOT a file or path" in directive
        # The two recovery mechanisms are deliberately distinct.
        assert directive.index("sandbox-local `tool_output`") < directive.index(
            "/large_tool_results/..."
        )
