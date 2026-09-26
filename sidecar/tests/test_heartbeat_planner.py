"""Unit tests for heartbeat_planner agent."""
import pytest

from ccie_sidecar.agents import heartbeat_planner
from ccie_sidecar.agents.heartbeat_planner import (
    extract_interval,
    extract_entities,
    identify_agents,
    generate_agent_prompt,
    plan_heartbeat,
)


@pytest.fixture(autouse=True)
def use_deterministic_prompt_fallback(monkeypatch):
    """Keep planner unit tests independent of a developer's saved LLM config."""

    def no_test_llm(*_args, **_kwargs):
        raise RuntimeError("LLM disabled in heartbeat planner unit tests")

    monkeypatch.setattr(heartbeat_planner, "_generate_prompt_with_llm", no_test_llm)


class TestExtractInterval:
    """Tests for interval extraction from natural language."""

    def test_minutes(self):
        assert extract_interval("check every 5 minutes") == 5
        assert extract_interval("every 10 min") == 10
        assert extract_interval("every 1 minute") == 1

    def test_hours(self):
        assert extract_interval("check every 2 hours") == 120
        assert extract_interval("every 1 hour") == 60
        assert extract_interval("every 3 hr") == 180

    def test_days(self):
        assert extract_interval("check every day") == 1440
        assert extract_interval("every 2 days") == 2880

    def test_special_keywords(self):
        assert extract_interval("check hourly") == 60
        assert extract_interval("check every hour") == 60
        assert extract_interval("check daily") == 1440

    def test_no_interval_specified(self):
        """Should return default when no interval found."""
        assert extract_interval("check my network") == 30

    def test_minimum_constraint(self):
        """Should enforce minimum interval."""
        assert extract_interval("every 0 minutes") >= 1


class TestExtractEntities:
    """Tests for entity extraction."""

    def test_quoted_strings(self):
        text = 'check "Production Network" status'
        entities = extract_entities(text, {})
        # Should extract quoted strings
        assert "Production Network" in entities["networks"] or \
               "Production Network" in entities["testbeds"]

    def test_context_networks(self):
        text = "check production network"
        context = {"networks": ["Production", "Staging", "Dev"]}
        entities = extract_entities(text, context)
        assert "Production" in entities["networks"]

    def test_context_testbeds(self):
        text = "check lab testbed"
        context = {"testbeds": ["Lab", "Production"]}
        entities = extract_entities(text, context)
        assert "Lab" in entities["testbeds"]

    def test_no_context(self):
        text = "check network health"
        entities = extract_entities(text, {})
        # Should not crash, returns empty or inferred entities
        assert isinstance(entities, dict)


class TestIdentifyAgents:
    """Tests for agent identification."""

    def test_meraki_keywords(self):
        assert "meraki" in identify_agents("check Meraki network")
        assert "meraki" in identify_agents("wireless dashboard status")
        assert "meraki" in identify_agents("check my ssid")

    def test_pyats_keywords(self):
        assert "pyats" in identify_agents("check pyATS devices")
        assert "pyats" in identify_agents("testbed health")
        assert "pyats" in identify_agents("cisco device health")

    def test_stealthwatch_keywords(self):
        assert "stealthwatch" in identify_agents("check Stealthwatch")
        assert "stealthwatch" in identify_agents("flow analysis")

    def test_ise_keywords(self):
        assert "ise" in identify_agents("check cisco ise")
        assert "ise" in identify_agents("ise policy status")

    def test_cml_keywords(self):
        assert "cml" in identify_agents("check cisco cml")
        assert "cml" in identify_agents("modeling simulation")

    def test_catalyst_center_keywords(self):
        assert "catalyst_center" in identify_agents("check Catalyst Center")
        assert "catalyst_center" in identify_agents("DNAC assurance")

    def test_multiple_agents(self):
        agents = identify_agents("check Meraki and cisco ise")
        assert "meraki" in agents
        assert "ise" in agents

    def test_no_agents_identified(self):
        """Should return empty list when no keywords match."""
        agents = identify_agents("check something generic")
        assert agents == []


class TestGenerateAgentPrompt:
    """Tests for agent-specific prompt generation."""

    def test_meraki_with_networks(self):
        entities = {"networks": ["Production", "Guest"]}
        prompt = generate_agent_prompt("meraki", entities, "check networks")
        assert "Production" in prompt
        assert "Guest" in prompt

    def test_meraki_network_health_prompt_is_catalog_grounded_and_scoped(self):
        entities = {"networks": ["Example-Branch"]}

        prompt = generate_agent_prompt(
            "meraki",
            entities,
            "check Meraki health for Example-Branch every 45 minutes",
        )

        assert "search_api_catalog" in prompt
        assert "getOrganizationDevicesStatuses" in prompt
        assert "getOrganizationAssuranceAlerts" in prompt
        assert 'query_params={"networkIds": [network_id]}' in prompt
        assert 'query_params={"networkId": network_id, "active": True' in prompt
        assert "ONLY Example-Branch" in prompt
        assert "organization-wide" not in prompt.lower()

    def test_meraki_no_networks(self):
        entities = {"networks": []}
        prompt = generate_agent_prompt("meraki", entities, "check all")
        assert "Meraki" in prompt or "all" in prompt.lower()

    def test_pyats_with_testbed(self):
        entities = {"testbeds": ["Lab-Testbed"]}
        prompt = generate_agent_prompt("pyats", entities, "check testbed")
        assert "Lab-Testbed" in prompt

    def test_stealthwatch_prompt(self):
        prompt = generate_agent_prompt("stealthwatch", {}, "")
        assert "stealthwatch" in prompt.lower() or "security" in prompt.lower()

    def test_ise_prompt(self):
        prompt = generate_agent_prompt("ise", {}, "")
        assert "ise" in prompt.lower() or "authentication" in prompt.lower()

    def test_cml_prompt(self):
        prompt = generate_agent_prompt("cml", {}, "")
        assert "cml" in prompt.lower() or "lab" in prompt.lower()

    def test_catalyst_center_prompt(self):
        prompt = generate_agent_prompt("catalyst_center", {}, "")
        assert "catalyst" in prompt.lower() or "assurance" in prompt.lower()

    def test_unknown_agent_fallback(self):
        """Unknown agents should get generic prompt."""
        prompt = generate_agent_prompt("unknown_agent", {}, "")
        assert isinstance(prompt, str)
        assert len(prompt) > 0


class TestPlanHeartbeat:
    """Integration tests for full plan generation."""

    def test_simple_meraki_check(self):
        result = plan_heartbeat("check my Meraki network every 30 minutes")
        assert result["status"] == "success"
        assert result["plan"] is not None
        assert result["error"] is None

        plan = result["plan"]
        assert plan["interval_minutes"] == 30
        assert len(plan["checks"]) >= 1

        # Should have meraki check
        meraki_check = next(
            (c for c in plan["checks"] if c["agent_id"] == "meraki"),
            None
        )
        assert meraki_check is not None
        assert meraki_check["agent_prompt"]

    def test_multi_agent_check(self):
        result = plan_heartbeat("check Meraki and cisco ise every hour")
        assert result["status"] == "success"

        plan = result["plan"]
        assert plan["interval_minutes"] == 60
        assert len(plan["checks"]) == 2

        agent_ids = {c["agent_id"] for c in plan["checks"]}
        assert "meraki" in agent_ids
        assert "ise" in agent_ids

    def test_pyats_with_context(self):
        context = {"testbeds": ["Lab", "Production"]}
        result = plan_heartbeat("check Lab testbed every 15 minutes", context)

        assert result["status"] == "success"
        plan = result["plan"]
        assert plan["interval_minutes"] == 15

        pyats_check = next(
            (c for c in plan["checks"] if c["agent_id"] == "pyats"),
            None
        )
        assert pyats_check is not None
        assert "Lab" in pyats_check["agent_prompt"]

    def test_no_agents_identified_error(self):
        result = plan_heartbeat("check something vague every 10 minutes")
        assert result["status"] == "error"
        assert result["plan"] is None
        assert "Could not identify" in result["error"]

    def test_default_interval(self):
        """When no interval specified, should use default."""
        result = plan_heartbeat("check Meraki network")
        assert result["status"] == "success"
        assert result["plan"]["interval_minutes"] == 30

    def test_check_sorting(self):
        """Checks should be sorted and have sort_order."""
        result = plan_heartbeat("check Meraki, ISE, and CML every hour")
        assert result["status"] == "success"

        checks = result["plan"]["checks"]
        # Should have sort_order field
        for check in checks:
            assert "sort_order" in check
            assert isinstance(check["sort_order"], int)

        # Verify they're sorted
        sort_orders = [c["sort_order"] for c in checks]
        assert sort_orders == sorted(sort_orders)

    def test_plan_structure(self):
        """Verify complete plan structure."""
        result = plan_heartbeat("check Meraki hourly")
        assert result["status"] == "success"

        plan = result["plan"]
        # Required top-level fields
        assert "name" in plan
        assert "description" in plan
        assert "interval_minutes" in plan
        assert "checks" in plan

        # Check structure
        for check in plan["checks"]:
            assert "check_group_name" in check
            assert "agent_id" in check
            assert "agent_prompt" in check
            assert "sort_order" in check

    def test_exception_handling(self):
        """Should handle exceptions gracefully."""
        # Pass invalid types
        result = plan_heartbeat(None, None)
        assert result["status"] == "error"
        assert result["error"] is not None

    def test_daily_interval(self):
        result = plan_heartbeat("check cisco ise daily")
        assert result["status"] == "success"
        assert result["plan"]["interval_minutes"] == 1440


class TestEdgeCases:
    """Edge cases and boundary conditions."""

    def test_empty_input(self):
        result = plan_heartbeat("")
        assert result["status"] == "error"

    def test_very_long_input(self):
        long_input = "check " + " and ".join(["Meraki"] * 100) + " every hour"
        result = plan_heartbeat(long_input)
        # Should still work
        assert result["status"] == "success"

    def test_special_characters(self):
        result = plan_heartbeat('check "My Network!@#$" every 5 minutes')
        # Should handle special chars in quoted strings
        assert result["status"] == "success" or result["status"] == "error"

    def test_case_insensitive(self):
        """Keywords should be case-insensitive."""
        result1 = plan_heartbeat("check MERAKI every hour")
        result2 = plan_heartbeat("check meraki every hour")
        result3 = plan_heartbeat("check Meraki every hour")

        assert result1["status"] == "success"
        assert result2["status"] == "success"
        assert result3["status"] == "success"
