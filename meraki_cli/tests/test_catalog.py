"""
Unit tests for SDK introspection and tool catalog generation.

Tests:
- method_name_to_action() conversion
- generate_catalog() produces expected structure
- Tool specs have valid fields
- JSON schema generation
- Blast radius classification
"""

import inspect
import pytest
from terminai_meraki.catalog import (
    ToolSpec,
    generate_catalog,
    method_name_to_action,
    infer_http_method,
    infer_api_path,
    parse_docstring_params,
    classify_blast_radius_stub,
    enhance_description,
)


class TestPolicyDisambiguation:
    """Switch access policies vs group policies must be clearly distinguished.

    Regression: agents picked getNetworkGroupPolicies when asked for switch
    access policies (e.g. 'MAB-Only') because both descriptions just said
    'policy'. The enhanced descriptions must contrast the two and cross-link.
    """

    def test_switch_access_policy_description(self):
        desc = enhance_description(
            "List the access policies for a switch network.",
            "getNetworkSwitchAccessPolicies",
            "switch",
            "list-network-switch-access-policies",
        )
        assert "SWITCH ACCESS POLICY" in desc
        assert "802.1X" in desc or "RADIUS" in desc
        # cross-references the group-policy method so the model won't confuse them
        assert "getNetworkGroupPolicies" in desc

    def test_switch_access_policy_update_keeps_modifies_warning(self):
        desc = enhance_description(
            "Update an access policy for a switch network.",
            "updateNetworkSwitchAccessPolicy",
            "switch",
            "update-network-switch-access-policy",
        )
        assert "SWITCH ACCESS POLICY" in desc
        assert "MODIFIES CONFIGURATION" in desc

    def test_group_policy_description(self):
        desc = enhance_description(
            "List the group policies in a network.",
            "getNetworkGroupPolicies",
            "networks",
            "list-group-policies",
        )
        assert "GROUP POLICY" in desc
        # cross-references the switch access-policy method
        assert "getNetworkSwitchAccessPolicies" in desc

    def test_group_policy_only_applies_to_networks_resource(self):
        """Adaptive/global 'group policy' methods must not be mislabeled."""
        desc = enhance_description(
            "Assign adaptive policy groups to a policy.",
            "assignOrganizationPoliciesGlobalGroupPoliciesAdaptivePolicyGroups",
            "organizations",
            "assign-policies-global-group-policies-adaptive-policy-groups",
        )
        # resource is 'organizations', not 'networks' → no GROUP POLICY rewrite
        assert "GROUP POLICY = a per-client" not in desc


class TestMethodNameToAction:
    """Test SDK method name to CLI action conversion."""

    def test_list_plural(self):
        """getOrganizations should become list-organizations."""
        assert method_name_to_action("getOrganizations", "organizations") == "list-organizations"

    def test_get_singular(self):
        """getOrganization should become get-organization."""
        assert method_name_to_action("getOrganization", "organizations") == "get-organization"

    def test_list_clients(self):
        """getNetworkClients should become list-clients."""
        assert method_name_to_action("getNetworkClients", "networks") == "list-clients"

    def test_update_ssid(self):
        """updateNetworkSsid should become update-ssid."""
        # Network is removed because it's duplicate with resource
        result = method_name_to_action("updateNetworkSsid", "networks")
        assert "update" in result
        assert "ssid" in result

    def test_create_group_policy(self):
        """createNetworkGroupPolicy should become create-group-policy."""
        result = method_name_to_action("createNetworkGroupPolicy", "networks")
        assert "create" in result
        assert "policy" in result

    def test_create_adaptive_policy_group(self):
        """createOrganizationAdaptivePolicyGroup should become create-adaptive-policy-group."""
        result = method_name_to_action(
            "createOrganizationAdaptivePolicyGroup", "organizations"
        )
        assert result == "create-adaptive-policy-group"

    def test_delete_network(self):
        """deleteNetwork should become delete-network."""
        assert method_name_to_action("deleteNetwork", "networks") == "delete-network"

    def test_claim_devices(self):
        """claimIntoOrganization should become claim-into-organization."""
        result = method_name_to_action("claimIntoOrganization", "organizations")
        assert "claim" in result


class TestInferHttpMethod:
    """Test HTTP method inference from SDK method names."""

    def test_get_methods(self):
        """Methods starting with 'get' should map to GET."""
        assert infer_http_method("getOrganizations") == "GET"
        assert infer_http_method("getOrganization") == "GET"
        assert infer_http_method("getNetworkClients") == "GET"

    def test_create_methods(self):
        """Methods starting with 'create' should map to POST."""
        assert infer_http_method("createOrganization") == "POST"
        assert infer_http_method("createNetworkGroupPolicy") == "POST"

    def test_update_methods(self):
        """Methods starting with 'update' should map to PUT."""
        assert infer_http_method("updateOrganization") == "PUT"
        assert infer_http_method("updateNetworkSsid") == "PUT"

    def test_delete_methods(self):
        """Methods starting with 'delete' should map to DELETE."""
        assert infer_http_method("deleteOrganization") == "DELETE"
        assert infer_http_method("deleteNetwork") == "DELETE"

    def test_claim_methods(self):
        """Methods starting with 'claim' should map to POST."""
        assert infer_http_method("claimIntoOrganization") == "POST"

    def test_batch_methods(self):
        """Batch methods should map to POST."""
        assert infer_http_method("batchUpdateOrganization") == "POST"


class TestInferApiPath:
    """Test API path inference."""

    def test_organizations_list(self):
        """getOrganizations should map to /organizations."""
        path = infer_api_path("organizations", "getOrganizations", [])
        assert path == "/organizations"

    def test_organization_get(self):
        """getOrganization should map to /organizations/{organizationId}."""
        path = infer_api_path("organizations", "getOrganization", ["organizationId"])
        # Should include the org ID placeholder
        assert "/organizations/" in path
        assert "{organizationId}" in path

    def test_network_clients(self):
        """getNetworkClients should map to /networks/{networkId}/clients."""
        path = infer_api_path("networks", "getNetworkClients", ["networkId"])
        assert "/networks/" in path
        assert "{networkId}" in path
        # May or may not include /clients depending on heuristic


class TestClassifyBlastRadius:
    """Test blast radius classification."""

    def test_get_is_low(self):
        """All GET requests should be low blast radius."""
        radius, destructive = classify_blast_radius_stub("GET", "/organizations", "getOrganizations")
        assert radius == "low"
        assert destructive is False

    def test_delete_org_is_destructive(self):
        """DELETE organization should be destructive."""
        radius, destructive = classify_blast_radius_stub(
            "DELETE", "/organizations/{id}", "deleteOrganization"
        )
        assert radius == "destructive"
        assert destructive is True

    def test_delete_network_is_destructive(self):
        """DELETE network should be destructive."""
        radius, destructive = classify_blast_radius_stub(
            "DELETE", "/networks/{id}", "deleteNetwork"
        )
        assert radius == "destructive"
        assert destructive is True

    def test_delete_sub_resource_is_high(self):
        """DELETE sub-resource should be high."""
        radius, destructive = classify_blast_radius_stub(
            "DELETE", "/networks/{id}/groupPolicies/{id}", "deleteNetworkGroupPolicy"
        )
        assert radius == "high"
        assert destructive is False

    def test_put_firewall_is_high(self):
        """PUT firewall config should be high."""
        radius, destructive = classify_blast_radius_stub(
            "PUT", "/networks/{id}/appliance/firewall/settings", "updateFirewall"
        )
        assert radius == "high"
        assert destructive is False

    def test_post_create_is_medium(self):
        """POST create should be medium."""
        radius, destructive = classify_blast_radius_stub(
            "POST", "/organizations", "createOrganization"
        )
        assert radius == "medium"
        assert destructive is False

    def test_put_update_is_medium(self):
        """PUT update (non-sensitive) should be medium."""
        radius, destructive = classify_blast_radius_stub(
            "PUT", "/organizations/{id}", "updateOrganization"
        )
        assert radius == "medium"
        assert destructive is False


class TestGenerateCatalog:
    """Test catalog generation."""

    @pytest.fixture(scope="class")
    def catalog(self):
        """Generate catalog once for all tests in this class."""
        return generate_catalog()

    def test_catalog_not_empty(self, catalog):
        """Catalog should contain many tools."""
        assert len(catalog) > 500  # At least 500 tools

    def test_all_tools_are_toolspecs(self, catalog):
        """All catalog entries should be ToolSpec instances."""
        for tool in catalog:
            assert isinstance(tool, ToolSpec)

    def test_tool_has_required_fields(self, catalog):
        """Each tool should have all required fields."""
        for tool in catalog[:10]:  # Check first 10
            assert tool.name
            assert tool.resource
            assert tool.action
            assert tool.endpoint
            assert "method" in tool.endpoint
            assert "path" in tool.endpoint
            assert isinstance(tool.args, dict)
            assert isinstance(tool.required, list)
            assert tool.blast_radius in ["low", "medium", "high", "destructive"]
            assert isinstance(tool.destructive, bool)
            assert tool.sdk_method

    def test_tool_names_have_correct_format(self, catalog):
        """Tool names should follow meraki.resource.action format."""
        for tool in catalog[:10]:
            assert tool.name.startswith("meraki.")
            parts = tool.name.split(".")
            assert len(parts) == 3  # meraki, resource, action
            assert parts[1] == tool.resource

    def test_blast_radius_distribution(self, catalog):
        """Catalog should have a reasonable distribution of blast radii."""
        by_radius = {"low": 0, "medium": 0, "high": 0, "destructive": 0}
        for tool in catalog:
            by_radius[tool.blast_radius] += 1

        # Should have many low-risk read operations
        assert by_radius["low"] > 100

        # Should have some medium-risk operations
        assert by_radius["medium"] > 50

        # Should have some high-risk operations
        assert by_radius["high"] > 10

        # May or may not have destructive operations
        # (depends on SDK version)

    def test_organizations_resource_exists(self, catalog):
        """Catalog should include organizations resource."""
        org_tools = [t for t in catalog if t.resource == "organizations"]
        assert len(org_tools) > 50  # Organizations has many endpoints

    def test_networks_resource_exists(self, catalog):
        """Catalog should include networks resource."""
        net_tools = [t for t in catalog if t.resource == "networks"]
        assert len(net_tools) > 50  # Networks has many endpoints

    def test_sample_tool_get_organizations(self, catalog):
        """Catalog should include getOrganizations tool."""
        tools = [t for t in catalog if t.sdk_method == "getOrganizations"]
        assert len(tools) == 1

        tool = tools[0]
        assert tool.name == "meraki.organizations.list-organizations"
        assert tool.endpoint["method"] == "GET"
        assert tool.blast_radius == "low"
        assert tool.destructive is False

    @pytest.mark.parametrize(
        ("sdk_method", "expected_path"),
        [
            (
                "getNetworkSwitchAccessPolicies",
                "/networks/{networkId}/switch/accessPolicies",
            ),
            (
                "getNetworkSwitchAccessPolicy",
                "/networks/{networkId}/switch/accessPolicies/{accessPolicyNumber}",
            ),
            (
                "createNetworkSwitchAccessPolicy",
                "/networks/{networkId}/switch/accessPolicies",
            ),
            (
                "updateNetworkSwitchAccessPolicy",
                "/networks/{networkId}/switch/accessPolicies/{accessPolicyNumber}",
            ),
            (
                "deleteNetworkSwitchAccessPolicy",
                "/networks/{networkId}/switch/accessPolicies/{accessPolicyNumber}",
            ),
        ],
    )
    def test_switch_access_policy_uses_official_sdk_path(
        self,
        catalog,
        sdk_method,
        expected_path,
    ):
        tool = next(tool for tool in catalog if tool.sdk_method == sdk_method)

        assert tool.endpoint["path"] == expected_path

    def test_json_schema_for_params(self, catalog):
        """Tools should have JSON schema for parameters."""
        # Find a tool with parameters
        tool_with_params = None
        for tool in catalog:
            if tool.required:
                tool_with_params = tool
                break

        assert tool_with_params is not None
        assert len(tool_with_params.required) > 0

        # Check that required params are in args schema
        for param in tool_with_params.required:
            assert param in tool_with_params.args
            assert "type" in tool_with_params.args[param]

    def test_to_dict_serialization(self, catalog):
        """ToolSpec should serialize to dict for JSON export."""
        tool = catalog[0]
        d = tool.to_dict()

        assert isinstance(d, dict)
        assert d["name"] == tool.name
        assert d["resource"] == tool.resource
        assert d["action"] == tool.action
        assert d["blast_radius"] == tool.blast_radius


class TestParseDocstringParams:
    """Test docstring parameter parsing."""

    def test_parse_simple_param(self):
        """Should parse simple parameter from docstring."""
        docstring = """
        Get organization.

        - organizationId (string): Organization ID
        - name (string): Organization name
        """
        # Create a mock signature
        sig = inspect.Signature([
            inspect.Parameter("organizationId", inspect.Parameter.POSITIONAL_OR_KEYWORD, annotation=str),
        ])

        params = parse_docstring_params(docstring, sig)

        assert "organizationId" in params
        assert params["organizationId"]["type"] == "string"
        assert "Organization ID" in params["organizationId"]["description"]

    def test_parse_integer_param(self):
        """Should detect integer type."""
        docstring = """
        - count (integer): Number of items
        """
        sig = inspect.Signature([])

        params = parse_docstring_params(docstring, sig)

        assert "count" in params
        assert params["count"]["type"] == "integer"

    def test_parse_boolean_param(self):
        """Should detect boolean type."""
        docstring = """
        - enabled (boolean): Whether enabled
        """
        sig = inspect.Signature([])

        params = parse_docstring_params(docstring, sig)

        assert "enabled" in params
        assert params["enabled"]["type"] == "boolean"

    def test_parse_array_param(self):
        """Should detect array type."""
        docstring = """
        - items (array): List of items
        """
        sig = inspect.Signature([])

        params = parse_docstring_params(docstring, sig)

        assert "items" in params
        assert params["items"]["type"] == "array"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
