"""Tests for heartbeat check execution."""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from ccie_sidecar.agents.heartbeat_executor import (
    execute_check,
    _parse_pyats_output,
    _parse_meraki_output,
    _parse_stealthwatch_output,
    _parse_ise_output,
    _parse_cml_output,
    _parse_catalyst_center_output,
    _parse_generic_output,
)


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

        # Mock asyncio.run to return empty findings
        mock_asyncio_run.return_value = {"findings": []}

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

        # Mock asyncio.run to return a timeout result (as if _run_agent_with_timeout caught it)
        mock_asyncio_run.return_value = {
            "findings": [
                {
                    "severity": "error",
                    "title": "Check execution timeout",
                    "message": "The agent 'test-agent' did not complete within 120 seconds.",
                    "metadata": {"check_id": "check-004", "agent_id": "test-agent", "timeout_seconds": 120}
                }
            ]
        }

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
