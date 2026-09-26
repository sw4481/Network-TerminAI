"""
Unit tests for blast-radius classifier.

Tests all table-driven rules with comprehensive path coverage.
"""

import pytest
from terminai_meraki.blast_radius import classify, OVERRIDES


class TestBlastRadiusClassifier:
    """Test suite for the blast-radius classifier."""

    # Table-driven tests for all classification rules
    @pytest.mark.parametrize("method,path,expected_tier,expected_destructive", [
        # Rule 1: All GETs are "low"
        ("GET", "/organizations", "low", False),
        ("GET", "/organizations/{id}", "low", False),
        ("GET", "/organizations/{id}/networks", "low", False),
        ("GET", "/networks/{id}/clients", "low", False),
        ("GET", "/networks/{id}/devices", "low", False),
        ("GET", "/devices/{serial}", "low", False),
        ("GET", "/networks/{id}/wireless/ssids/{number}", "low", False),

        # Rule 2: POST */action-batches -> "high"
        ("POST", "/organizations/{id}/actionBatches", "high", False),
        ("POST", "/actionBatches", "high", False),

        # Rule 3: POST */claim, */bind, */release -> "high"
        ("POST", "/networks/{id}/devices/claim", "high", False),
        ("POST", "/organizations/{id}/claim", "high", False),
        ("POST", "/networks/{id}/bind", "high", False),
        ("POST", "/devices/{serial}/bind", "high", False),
        ("POST", "/organizations/{id}/licenses/release", "high", False),

        # Rule 4: PUT */*/settings -> "high"
        ("PUT", "/networks/{id}/wireless/settings", "high", False),
        ("PUT", "/networks/{id}/appliance/settings", "high", False),
        ("PUT", "/organizations/{id}/camera/settings", "high", False),

        # Rule 4: PUT */*/policy -> "high"
        ("PUT", "/networks/{id}/groupPolicies/{id}", "high", False),
        ("PUT", "/networks/{id}/l3FirewallRules/policy", "high", False),

        # Rule 4: PUT */*/firewall/* -> "high"
        ("PUT", "/networks/{id}/appliance/firewall/l3FirewallRules", "high", False),
        ("PUT", "/networks/{id}/wireless/firewall/l7FirewallRules", "high", False),
        ("PUT", "/networks/{id}/switch/firewall/portSchedules/{id}", "high", False),

        # Rule 5: PUT * (other) -> "medium"
        ("PUT", "/networks/{id}", "medium", False),
        ("PUT", "/networks/{id}/ssids/{number}", "medium", False),
        ("PUT", "/networks/{id}/devices/{serial}", "medium", False),
        ("PUT", "/organizations/{id}/admins/{id}", "medium", False),

        # Rule 6: POST * (other) -> "medium"
        ("POST", "/networks", "medium", False),
        ("POST", "/organizations/{id}/networks", "medium", False),
        ("POST", "/networks/{id}/alerts/history", "medium", False),

        # Rule 7: DELETE */organizations/* (top-level) -> "destructive"
        ("DELETE", "/organizations/{id}", "destructive", True),

        # Rule 7: DELETE */networks/* (top-level) -> "destructive"
        ("DELETE", "/networks/{id}", "destructive", True),

        # Rule 8: DELETE * (sub-resources) -> "high"
        ("DELETE", "/organizations/{id}/admins/{adminId}", "high", False),
        ("DELETE", "/networks/{id}/ssids/{number}", "high", False),
        ("DELETE", "/networks/{id}/devices/{serial}", "high", False),
        ("DELETE", "/organizations/{id}/configTemplates/{id}", "high", False),
    ])
    def test_classification_rules(self, method, path, expected_tier, expected_destructive):
        """Test all classification rules from the design spec."""
        tier, destructive = classify(method, path)
        assert tier == expected_tier, f"Expected tier '{expected_tier}' for {method} {path}, got '{tier}'"
        assert destructive == expected_destructive, f"Expected destructive={expected_destructive} for {method} {path}, got {destructive}"

    def test_override_table_ping_endpoints(self):
        """Test that ping endpoints are overridden to 'low' despite being POST."""
        # POST /networks/*/devices/*/ping -> "low" (override)
        tier, destructive = classify("POST", "/networks/N_123/devices/Q234-ABCD-5678/ping")
        assert tier == "low"
        assert destructive is False

        # POST /devices/*/liveTools/ping -> "low" (override)
        tier, destructive = classify("POST", "/devices/Q234-ABCD-5678/liveTools/ping")
        assert tier == "low"
        assert destructive is False

        # POST /devices/*/liveTools/pingDevice -> "low" (override)
        tier, destructive = classify("POST", "/devices/Q234-ABCD-5678/liveTools/pingDevice")
        assert tier == "low"
        assert destructive is False

    def test_override_table_blink_leds(self):
        """Test that blinkLeds endpoints are overridden to 'low' despite being POST."""
        # POST /networks/*/devices/*/blinkLeds -> "low" (override)
        tier, destructive = classify("POST", "/networks/N_123/devices/Q234-ABCD-5678/blinkLeds")
        assert tier == "low"
        assert destructive is False

        # POST /devices/*/blinkLeds -> "low" (override)
        tier, destructive = classify("POST", "/devices/Q234-ABCD-5678/blinkLeds")
        assert tier == "low"
        assert destructive is False

    def test_override_table_cycle_switch_port(self):
        """Test that cycleSwitchPort endpoint is overridden to 'low' despite being POST."""
        tier, destructive = classify("POST", "/networks/N_123/devices/Q234-ABCD-5678/cycleSwitchPort")
        assert tier == "low"
        assert destructive is False

    def test_destructive_flag_only_for_top_level_deletes(self):
        """Test that destructive flag is ONLY True for DELETE on orgs/networks."""
        # Top-level deletes: destructive = True
        _, destructive = classify("DELETE", "/organizations/O_123")
        assert destructive is True

        _, destructive = classify("DELETE", "/networks/N_456")
        assert destructive is True

        # Sub-resource deletes: destructive = False
        _, destructive = classify("DELETE", "/organizations/O_123/admins/A_789")
        assert destructive is False

        _, destructive = classify("DELETE", "/networks/N_456/ssids/0")
        assert destructive is False

        _, destructive = classify("DELETE", "/devices/Q234-ABCD-5678")
        assert destructive is False

        # Non-DELETE methods: destructive = False
        _, destructive = classify("GET", "/organizations/O_123")
        assert destructive is False

        _, destructive = classify("PUT", "/networks/N_456")
        assert destructive is False

        _, destructive = classify("POST", "/organizations/O_123/networks")
        assert destructive is False

    def test_settings_policy_firewall_always_high(self):
        """Test that settings/policy/firewall changes are always 'high' tier."""
        # Settings
        tier, _ = classify("PUT", "/networks/N_123/wireless/settings")
        assert tier == "high"

        tier, _ = classify("PUT", "/networks/N_123/appliance/settings")
        assert tier == "high"

        # Policy
        tier, _ = classify("PUT", "/networks/N_123/groupPolicies/GP_456")
        assert tier == "high"

        # Firewall (nested paths)
        tier, _ = classify("PUT", "/networks/N_123/appliance/firewall/l3FirewallRules")
        assert tier == "high"

        tier, _ = classify("PUT", "/networks/N_123/wireless/firewall/l7FirewallRules")
        assert tier == "high"

    def test_default_put_is_medium(self):
        """Test that PUT operations not matching high-tier patterns are 'medium'."""
        tier, _ = classify("PUT", "/networks/N_123")
        assert tier == "medium"

        tier, _ = classify("PUT", "/networks/N_123/ssids/0")
        assert tier == "medium"

        tier, _ = classify("PUT", "/organizations/O_123/saml")
        assert tier == "medium"

    def test_default_post_is_medium(self):
        """Test that POST operations not matching high-tier patterns are 'medium'."""
        tier, _ = classify("POST", "/networks")
        assert tier == "medium"

        tier, _ = classify("POST", "/organizations/O_123/networks")
        assert tier == "medium"

        tier, _ = classify("POST", "/networks/N_123/splitNetworks")
        assert tier == "medium"

    def test_edge_cases_unknown_methods(self):
        """Test that unknown HTTP methods default to 'high' tier (conservative)."""
        tier, destructive = classify("PATCH", "/networks/N_123")
        assert tier == "high"
        assert destructive is False

        tier, destructive = classify("OPTIONS", "/organizations")
        assert tier == "high"
        assert destructive is False

    def test_edge_cases_empty_paths(self):
        """Test that empty or root paths are handled gracefully."""
        tier, destructive = classify("GET", "")
        assert tier == "low"
        assert destructive is False

        tier, destructive = classify("POST", "/")
        assert tier == "medium"
        assert destructive is False

    def test_case_insensitivity_of_method(self):
        """Test that HTTP method is case-insensitive."""
        # Lowercase
        tier, _ = classify("get", "/organizations")
        assert tier == "low"

        # Uppercase
        tier, _ = classify("GET", "/organizations")
        assert tier == "low"

        # Mixed case
        tier, _ = classify("Get", "/organizations")
        assert tier == "low"

    def test_override_table_completeness(self):
        """Test that all entries in OVERRIDES table are valid."""
        for (method, path), (tier, destructive) in OVERRIDES.items():
            # Verify tier is valid
            assert tier in ["low", "medium", "high", "destructive"], \
                f"Invalid tier '{tier}' in OVERRIDES for {method} {path}"

            # Verify destructive is boolean
            assert isinstance(destructive, bool), \
                f"Invalid destructive value '{destructive}' in OVERRIDES for {method} {path}"

            # Verify override is actually applied
            result_tier, result_destructive = classify(method, path.replace("*", "test123"))
            assert result_tier == tier, \
                f"Override not applied for {method} {path}"
            assert result_destructive == destructive, \
                f"Override destructive flag not applied for {method} {path}"

    def test_action_batches_edge_cases(self):
        """Test various path patterns for action-batches."""
        # Standard pattern
        tier, _ = classify("POST", "/organizations/O_123/actionBatches")
        assert tier == "high"

        # Without leading slash
        tier, _ = classify("POST", "actionBatches")
        assert tier == "high"

        # With query parameters (path should not include query, but test defensively)
        tier, _ = classify("POST", "/organizations/O_123/actionBatches?confirmed=true")
        assert tier == "high"

    def test_claim_bind_release_variations(self):
        """Test various path patterns for claim/bind/release operations."""
        # Claim variations
        tier, _ = classify("POST", "/networks/N_123/devices/claim")
        assert tier == "high"

        tier, _ = classify("POST", "/organizations/O_123/claim")
        assert tier == "high"

        # Bind variations
        tier, _ = classify("POST", "/networks/N_123/bind")
        assert tier == "high"

        # Release variations
        tier, _ = classify("POST", "/organizations/O_123/licenses/release")
        assert tier == "high"

    def test_multi_level_firewall_paths(self):
        """Test firewall paths at various nesting levels."""
        # 2-level: /networks/{id}/firewall/*
        tier, _ = classify("PUT", "/networks/N_123/firewall/l3Rules")
        assert tier == "high"

        # 3-level: /networks/{id}/appliance/firewall/*
        tier, _ = classify("PUT", "/networks/N_123/appliance/firewall/l3FirewallRules")
        assert tier == "high"

        # 4-level: /networks/{id}/appliance/firewall/portForwarding
        tier, _ = classify("PUT", "/networks/N_123/appliance/firewall/portForwarding/rules")
        assert tier == "high"

    def test_comprehensive_delete_paths(self):
        """Test DELETE on various resource types."""
        # Top-level (destructive)
        tier, destructive = classify("DELETE", "/organizations/O_123")
        assert tier == "destructive" and destructive is True

        tier, destructive = classify("DELETE", "/networks/N_456")
        assert tier == "destructive" and destructive is True

        # Admins (high, not destructive)
        tier, destructive = classify("DELETE", "/organizations/O_123/admins/A_789")
        assert tier == "high" and destructive is False

        # SSIDs (high, not destructive)
        tier, destructive = classify("DELETE", "/networks/N_456/ssids/5")
        assert tier == "high" and destructive is False

        # Config templates (high, not destructive)
        tier, destructive = classify("DELETE", "/organizations/O_123/configTemplates/CT_999")
        assert tier == "high" and destructive is False

        # Devices (high, not destructive)
        tier, destructive = classify("DELETE", "/networks/N_456/devices/Q234-ABCD-5678")
        assert tier == "high" and destructive is False

    def test_real_world_meraki_paths(self):
        """Test with real Meraki Dashboard API endpoint paths."""
        # Read operations
        assert classify("GET", "/organizations/123456/networks")[0] == "low"
        assert classify("GET", "/networks/L_123/clients")[0] == "low"
        assert classify("GET", "/devices/Q2XX-XXXX-XXXX")[0] == "low"

        # Claim device (high-impact)
        assert classify("POST", "/networks/L_123/devices/claim")[0] == "high"

        # Update SSID (medium)
        assert classify("PUT", "/networks/L_123/wireless/ssids/0")[0] == "medium"

        # Update firewall rules (high)
        assert classify("PUT", "/networks/L_123/appliance/firewall/l3FirewallRules")[0] == "high"

        # Delete network (destructive)
        tier, destructive = classify("DELETE", "/networks/L_123")
        assert tier == "destructive" and destructive is True

        # Delete SSID (high, not destructive)
        tier, destructive = classify("DELETE", "/networks/L_123/wireless/ssids/5")
        assert tier == "high" and destructive is False


class TestClassifierReturnTypes:
    """Test that classifier returns correct types."""

    def test_returns_tuple(self):
        """Test that classify() returns a tuple."""
        result = classify("GET", "/organizations")
        assert isinstance(result, tuple)
        assert len(result) == 2

    def test_tier_is_string(self):
        """Test that tier is a string."""
        tier, _ = classify("GET", "/organizations")
        assert isinstance(tier, str)

    def test_destructive_is_boolean(self):
        """Test that destructive is a boolean."""
        _, destructive = classify("GET", "/organizations")
        assert isinstance(destructive, bool)

    def test_tier_values_are_valid(self):
        """Test that all possible tier values are in the expected set."""
        valid_tiers = {"low", "medium", "high", "destructive"}

        # Test a variety of paths
        test_cases = [
            ("GET", "/organizations"),
            ("POST", "/networks"),
            ("PUT", "/networks/{id}"),
            ("PUT", "/networks/{id}/wireless/settings"),
            ("DELETE", "/organizations/{id}"),
            ("DELETE", "/networks/{id}/ssids/0"),
        ]

        for method, path in test_cases:
            tier, _ = classify(method, path)
            assert tier in valid_tiers, f"Invalid tier '{tier}' for {method} {path}"
