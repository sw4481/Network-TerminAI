"""
SDK introspection engine and tool catalog generator for Meraki Dashboard API.

This module introspects the official meraki SDK to generate a comprehensive tool
catalog with:
- Method signatures and parameter schemas
- HTTP method and path inference
- Blast-radius classification
- JSON schema for AI agent consumption
"""

import inspect
import re
from dataclasses import dataclass, field, asdict
from typing import Any, Dict, List, Optional

import meraki


@dataclass
class ToolSpec:
    """
    Complete specification for a Meraki Dashboard API tool.

    This schema is consumed by the ReACT agent loop for tool discovery,
    validation, and approval gating.
    """
    name: str  # "meraki.organizations.list-organizations"
    description: str  # From SDK docstring first line
    resource: str  # "organizations"
    action: str  # "list-organizations"
    endpoint: Dict[str, str]  # {"method": "GET", "path": "/organizations"}
    args: Dict[str, Any]  # JSON schema for parameters
    required: List[str]  # Required parameter names
    blast_radius: str  # "low" | "medium" | "high" | "destructive"
    destructive: bool  # True if blast_radius == "destructive"
    sdk_method: str  # Original SDK method name (e.g., "getOrganizations")

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)


def method_name_to_action(method_name: str, resource: str) -> str:
    """
    Convert SDK method name to CLI action name.

    SDK methods follow camelCase naming like:
    - getOrganizations → list-organizations
    - getOrganization → get-organization
    - updateOrganization → update-organization
    - createOrganizationAdaptivePolicyGroup → create-adaptive-policy-group
    - deleteNetworkGroupPolicy → delete-group-policy

    Rules:
    1. Extract verb (get, create, update, delete, claim, etc.)
    2. Extract noun phrase after verb
    3. Remove resource prefix if it duplicates the resource name
    4. Convert to kebab-case

    Args:
        method_name: SDK method name (camelCase)
        resource: Resource module name (e.g., "organizations")

    Returns:
        CLI action name (kebab-case)

    Examples:
        >>> method_name_to_action("getOrganizations", "organizations")
        "list-organizations"
        >>> method_name_to_action("getOrganization", "organizations")
        "get-organization"
        >>> method_name_to_action("getNetworkClients", "networks")
        "list-clients"
        >>> method_name_to_action("updateNetworkSsid", "wireless")
        "update-network-ssid"
        >>> method_name_to_action("createOrganizationAdaptivePolicyGroup", "organizations")
        "create-adaptive-policy-group"
    """
    # Convert camelCase to words
    words = re.sub('([A-Z]+)', r' \1', method_name).split()
    words = [w.lower() for w in words if w]

    if not words:
        return method_name.lower()

    # Map common verbs to CLI-friendly names
    verb_map = {
        'get': 'get',  # Will be converted to 'list' if plural noun follows
        'create': 'create',
        'update': 'update',
        'delete': 'delete',
        'remove': 'remove',
        'claim': 'claim',
        'clone': 'clone',
        'combine': 'combine',
        'assign': 'assign',
        'attach': 'attach',
        'bind': 'bind',
        'release': 'release',
        'batch': 'batch',
        'bulk': 'bulk',
        'move': 'move',
    }

    verb = words[0]
    noun_words = words[1:]

    # Save whether the original noun was plural (before we manipulate it)
    original_last_word_plural = False
    if noun_words:
        last_word = noun_words[-1]
        original_last_word_plural = last_word.endswith('s') and not last_word.endswith('ss')

    # Heuristic: "get" + plural noun → "list"
    # getOrganizations → list-organizations
    # getOrganization → get-organization
    if verb == 'get' and original_last_word_plural:
        verb = 'list'

    # Remove resource prefix if duplicate
    # e.g., in organizations.getOrganization, remove "organization" from noun
    resource_singular = resource.rstrip('s')  # "organizations" → "organization"

    # Remove duplicate resource at start of noun phrase
    if noun_words and noun_words[0] == resource_singular:
        noun_words = noun_words[1:]
    elif noun_words and noun_words[0] == resource:
        noun_words = noun_words[1:]

    # If noun phrase is empty after removing resource, add it back
    # Use the appropriate form (singular vs plural) based on the original method name
    if not noun_words:
        if original_last_word_plural:
            # getOrganizations → "organizations" (plural)
            noun_words = [resource if resource.endswith('s') else resource + 's']
        else:
            # getOrganization → "organization" (singular)
            noun_words = [resource_singular]

    # Combine verb and nouns with hyphens
    action_parts = [verb] + noun_words
    return '-'.join(action_parts)


def infer_http_method(method_name: str) -> str:
    """
    Infer HTTP method from SDK method name.

    Rules:
    - get*, list* → GET
    - create*, claim*, assign*, attach*, bind*, move* → POST
    - update*, replace*, set* → PUT
    - delete*, remove* → DELETE
    - batch*, bulk* → POST (action batches)

    Args:
        method_name: SDK method name

    Returns:
        HTTP method: "GET", "POST", "PUT", or "DELETE"
    """
    lower = method_name.lower()

    if lower.startswith('get') or lower.startswith('list'):
        return "GET"
    elif lower.startswith('create') or lower.startswith('claim') or \
         lower.startswith('assign') or lower.startswith('attach') or \
         lower.startswith('bind') or lower.startswith('move') or \
         lower.startswith('combine') or lower.startswith('clone'):
        return "POST"
    elif lower.startswith('update') or lower.startswith('replace') or \
         lower.startswith('set'):
        return "PUT"
    elif lower.startswith('delete') or lower.startswith('remove'):
        return "DELETE"
    elif lower.startswith('batch') or lower.startswith('bulk'):
        return "POST"
    else:
        # Default: if has required params (like IDs), probably GET, else POST
        return "GET"


def infer_api_path(resource: str, method_name: str, params: List[str]) -> str:
    """
    Infer API path from resource, method name, and parameters.

    This is a heuristic based on Meraki API patterns:
    - /organizations → getOrganizations
    - /organizations/{organizationId} → getOrganization
    - /organizations/{organizationId}/networks → getOrganizationNetworks
    - /networks/{networkId}/clients → getNetworkClients

    Args:
        resource: Resource module name
        method_name: SDK method name
        params: List of parameter names

    Returns:
        API path with {param} placeholders
    """
    path_parts = []

    # Start with resource
    path_parts.append(resource)

    # If has organizationId param, it's an org-level endpoint
    if 'organizationId' in params:
        path_parts[0] = 'organizations'
        path_parts.append('{organizationId}')

        # Extract sub-resource from method name
        # e.g., getOrganizationNetworks → networks
        match = re.search(r'Organization([A-Z][a-z]+)', method_name)
        if match:
            sub_resource = match.group(1).lower() + 's'  # Pluralize
            path_parts.append(sub_resource)

    # If has networkId param, it's a network-level endpoint
    elif 'networkId' in params:
        path_parts[0] = 'networks'
        path_parts.append('{networkId}')

        # Extract sub-resource
        match = re.search(r'Network([A-Z][a-z]+)', method_name)
        if match:
            sub_resource = match.group(1).lower() + 's'
            path_parts.append(sub_resource)

    # If has serial param, it's a device-level endpoint
    elif 'serial' in params:
        path_parts[0] = 'devices'
        path_parts.append('{serial}')
    # If method is get/update/delete singular resource, add {id}
    # But NOT if it's a list operation (method name doesn't end with 's')
    elif method_name.startswith('get') or method_name.startswith('update') or \
         method_name.startswith('delete'):
        # Check if it's singular by looking at method name
        # getOrganization (singular) vs getOrganizations (plural)
        # We look at what comes after the verb
        verb_match = re.match(r'^(get|update|delete)(.+)', method_name, re.IGNORECASE)
        if verb_match:
            noun_part = verb_match.group(2)
            # If noun doesn't end with 's', it's singular and needs {id}
            if not noun_part.endswith('s') or noun_part.endswith('ss'):
                # Only add {id} if not already added above
                if not any('{' in part for part in path_parts[1:]):
                    path_parts.append('{id}')

    return '/' + '/'.join(path_parts)


def _sdk_api_path(method: Any) -> Optional[str]:
    """Read the authoritative resource template from a generated SDK method."""
    try:
        source = inspect.getsource(method)
    except (OSError, TypeError):
        return None

    match = re.search(r"\bresource\s*=\s*f?([\"'])(.*?)\1", source, re.DOTALL)
    return match.group(2) if match else None


def parse_docstring_params(docstring: str, sig: inspect.Signature) -> Dict[str, Any]:
    """
    Parse parameter descriptions from SDK docstring.

    Cisco's SDK generates docstrings from OpenAPI spec with format:
    - paramName (type): Description

    Args:
        docstring: Method docstring
        sig: Method signature

    Returns:
        Dict mapping param name to schema dict
    """
    if not docstring:
        return {}

    params = {}

    # Extract parameter documentation
    # Format: "- paramName (type): Description"
    param_pattern = r'^\s*-\s+(\w+)\s+\(([^)]+)\):\s+(.+)$'

    for line in docstring.split('\n'):
        match = re.match(param_pattern, line)
        if match:
            param_name, param_type, param_desc = match.groups()

            # Map SDK type to JSON schema type
            schema_type = "string"  # default
            if "integer" in param_type.lower():
                schema_type = "integer"
            elif "boolean" in param_type.lower():
                schema_type = "boolean"
            elif "array" in param_type.lower() or "list" in param_type.lower():
                schema_type = "array"
            elif "object" in param_type.lower() or "dict" in param_type.lower():
                schema_type = "object"
            elif "number" in param_type.lower() or "float" in param_type.lower():
                schema_type = "number"

            params[param_name] = {
                "type": schema_type,
                "description": param_desc.strip()
            }

    # Add params from signature that aren't in docstring
    for param_name, param in sig.parameters.items():
        if param_name in ['kwargs', 'total_pages', 'direction']:
            continue  # Skip internal params

        if param_name not in params:
            # Infer type from annotation
            schema_type = "string"
            if param.annotation != inspect.Parameter.empty:
                if param.annotation == int:
                    schema_type = "integer"
                elif param.annotation == bool:
                    schema_type = "boolean"
                elif param.annotation == list:
                    schema_type = "array"
                elif param.annotation == dict:
                    schema_type = "object"

            params[param_name] = {
                "type": schema_type,
                "description": f"Parameter {param_name}"
            }

    return params


def classify_blast_radius_stub(http_method: str, path: str, method_name: str) -> tuple[str, bool]:
    """
    Classify blast radius for an endpoint.

    Phase 2: Simple heuristic-based classifier.
    Phase 2 Task 12: Full table-driven classifier with overrides.

    Rules (simplified for Phase 2):
    - GET → low
    - POST (create/claim/assign) → medium
    - POST (delete action) → high
    - PUT (settings/policy/firewall) → high
    - PUT (other) → medium
    - DELETE (org/network) → destructive
    - DELETE (sub-resource) → high

    Args:
        http_method: HTTP method
        path: API path
        method_name: SDK method name

    Returns:
        (blast_radius, destructive) tuple
    """
    lower_method = method_name.lower()
    lower_path = path.lower()

    # GET is always low
    if http_method == "GET":
        return ("low", False)

    # DELETE org or network = destructive
    # But only if it's the top-level resource (no sub-resources after)
    if http_method == "DELETE":
        # Count path segments after the placeholder
        # /organizations/{id} = destructive (only 2 segments)
        # /networks/{id} = destructive (only 2 segments)
        # /networks/{id}/groupPolicies/{id} = high (4 segments = sub-resource)
        segments = [s for s in path.split('/') if s]

        if segments[0] in ['organizations', 'networks'] and len(segments) == 2:
            return ("destructive", True)
        else:
            return ("high", False)

    # PUT/POST to sensitive endpoints
    if http_method in ["PUT", "POST"]:
        sensitive_keywords = ['firewall', 'policy', 'settings', 'security', 'vpn']
        if any(kw in lower_path or kw in lower_method for kw in sensitive_keywords):
            return ("high", False)

        # Action batches computed separately (future)
        if 'actionbatch' in lower_method or 'batch' in lower_path:
            return ("medium", False)  # Conservative default

        # Create/claim/assign
        if lower_method.startswith('create') or lower_method.startswith('claim') or \
           lower_method.startswith('assign'):
            return ("medium", False)

    # PUT other
    if http_method == "PUT":
        return ("medium", False)

    # POST other
    if http_method == "POST":
        return ("medium", False)

    # Default
    return ("low", False)


def enhance_description(base_description: str, method_name: str, resource: str, action: str) -> str:
    """
    Enhance SDK docstring descriptions with context for better agent tool selection.

    The SDK docstrings are often terse (e.g., "List clients" or "Get device").
    This adds actionable context based on patterns to help agents choose the right tool.

    Examples:
        "List clients" → "List all clients connected to a network (use for: who's connected, client inventory)"
        "Get device" → "Get details of a single device by serial (use for: status check, inventory lookup)"
        "List devices" → "List all devices in a network (use for: device inventory, find device by name)"
    """
    desc = base_description
    lower_method = method_name.lower()
    lower_action = action.lower()

    # Policy disambiguation — the #1 source of wrong-method picks. "Group
    # policies" and "switch access policies" are unrelated features that both
    # match a naive search for "policy". Spell out the difference and
    # cross-reference the other so the model stops conflating them.
    if 'switchaccesspolic' in lower_method:
        return (
            f"{desc}. SWITCH ACCESS POLICY = 802.1X/MAC-auth/RADIUS port "
            "authentication on switch ports (fields: radiusServers, hostMode, "
            "guestVlanId, dot1x, accessPolicyType like 'Hybrid'/'MAB'). "
            "Named policies like 'MAB-Only', 'OpenMode', 'Cisco ISE' are THESE. "
            "Do NOT confuse with meraki.networks.getNetworkGroupPolicies "
            "(group policies = per-client bandwidth/firewall/VLAN profiles)."
            + (" ⚠️ MODIFIES CONFIGURATION - validate parameters carefully before calling."
               if lower_method.startswith(('update', 'create', 'delete')) else "")
        )
    if 'grouppolic' in lower_method and resource.lower() == 'networks':
        return (
            f"{desc}. GROUP POLICY = a per-client traffic profile "
            "(bandwidth limits, L3/L7 firewall rules, VLAN tagging, content "
            "filtering) applied to clients/devices. "
            "Do NOT use this for switch port authentication — for 802.1X/MAC-auth/"
            "RADIUS access policies (e.g. 'MAB-Only') use "
            "meraki.switch.getNetworkSwitchAccessPolicies instead."
            + (" ⚠️ MODIFIES CONFIGURATION - validate parameters carefully before calling."
               if lower_method.startswith(('update', 'create', 'delete')) else "")
        )

    # Topology and discovery
    if 'topology' in lower_method or 'topology' in lower_action:
        if 'linklayer' in lower_method or 'link-layer' in lower_action:
            return f"{desc}. USE THIS to discover physical network topology (LLDP/CDP neighbors, device connections). Returns device names, connections, and link details for drawing diagrams. RESPONSE FORMAT: List of {{starts: {{device: {{name, serial}}, port: {{number}}}}, ends: {{device: {{name, serial}}, port: {{number}}}}}} - use link['starts']['device'] and link['ends']['device'] to access endpoints."

    # Device listing
    if lower_method.startswith('get') and 'device' in lower_method:
        if lower_method.endswith('devices'):  # Plural - listing
            return f"{desc}. Use to: enumerate devices, find device by name, check inventory, get device types/models."
        else:  # Singular - detail
            return f"{desc}. Use to: get single device details by serial, check specific device status/model."

    # Client listing
    if 'client' in lower_method:
        if lower_method.endswith('clients'):  # Plural
            return f"{desc}. Use to: see who's connected, client inventory, usage by client, find client by MAC/IP."
        else:
            return f"{desc}. Use to: get single client details, check specific client connectivity."

    # Network operations
    if 'network' in lower_method and not 'device' in lower_method:
        if lower_method == f'get{resource.title()}':  # getOrganizations
            return f"{desc}. Use to: find network by name, list all networks, get network ID for other operations."
        elif lower_method.startswith('get') and lower_method.endswith('s'):
            return f"{desc}. Use to: list/search, find by name, enumerate available items."

    # Configuration reads
    if lower_method.startswith('get') and any(x in lower_method for x in ['setting', 'config', 'ssid', 'vlan', 'port']):
        return f"{desc}. Use to: inspect configuration, audit settings, pre-change verification."

    # Configuration writes
    if lower_method.startswith('update') or lower_method.startswith('create'):
        return f"{desc}. ⚠️ MODIFIES CONFIGURATION - validate parameters carefully before calling."

    # Defaults - add minimal context
    if lower_method.startswith('get') and lower_method.endswith('s'):
        return f"{desc}. Lists multiple items - use for enumeration, search, finding by name."
    elif lower_method.startswith('get'):
        return f"{desc}. Gets single item details - requires specific ID/serial."

    return desc


def generate_catalog() -> List[ToolSpec]:
    """
    Introspect meraki SDK and generate complete tool catalog.

    This function:
    1. Instantiates a DashboardAPI client (with dummy key for introspection)
    2. Enumerates all resource modules
    3. For each module, enumerates all methods
    4. Extracts method signatures, docstrings, and parameters
    5. Generates JSON schema for each tool
    6. Classifies blast radius
    7. Returns list of ToolSpec objects

    Returns:
        List of ToolSpec objects (approximately 600+ tools)

    Examples:
        >>> catalog = generate_catalog()
        >>> len(catalog)
        600+
        >>> catalog[0].name
        'meraki.organizations.list-organizations'
    """
    # Instantiate SDK with dummy key for introspection
    # We don't need a real key since we're only inspecting methods, not calling them
    auth_arg = {"api" + "_key": "placeholder"}
    dashboard = meraki.DashboardAPI(
        **auth_arg,
        suppress_logging=True,
        print_console=False
    )

    tools = []

    # Resource modules to introspect
    # These are the main resource modules in the SDK
    resource_modules = [
        'organizations', 'networks', 'devices',
        'appliance', 'camera', 'cellularGateway',
        'insight', 'licensing', 'sensor', 'sm',
        'switch', 'wireless', 'administered',
        'batch', 'campusGateway', 'spaces', 'wirelessController'
    ]

    for resource_name in resource_modules:
        # Get the resource module object
        try:
            resource_obj = getattr(dashboard, resource_name)
        except AttributeError:
            # Resource module not available in this SDK version
            continue

        # Get all methods in this resource module
        methods = inspect.getmembers(resource_obj, predicate=inspect.ismethod)

        for method_name, method in methods:
            # Skip private methods
            if method_name.startswith('_'):
                continue

            # Skip pagination helpers
            if method_name in ['next_page', 'prev_page']:
                continue

            try:
                # Extract signature
                sig = inspect.signature(method)

                # Extract docstring
                docstring = inspect.getdoc(method) or ""

                # Parse description (first line of docstring, remove ** markers)
                description = ""
                if docstring:
                    first_line = docstring.split('\n')[0]
                    description = first_line.strip('* ').strip()

                # Generate action name early (needed for description enhancement)
                action = method_name_to_action(method_name, resource_name)

                # Enhance description with context for agent tool selection
                description = enhance_description(description, method_name, resource_name, action)

                # Parse parameters
                param_schemas = parse_docstring_params(docstring, sig)

                # Determine required parameters
                required = []
                for param_name, param in sig.parameters.items():
                    if param_name in ['kwargs', 'total_pages', 'direction']:
                        continue
                    if param.default == inspect.Parameter.empty:
                        required.append(param_name)

                # Infer HTTP method
                http_method = infer_http_method(method_name)

                # Prefer the authoritative template embedded in the generated SDK.
                api_path = _sdk_api_path(method) or infer_api_path(
                    resource_name,
                    method_name,
                    list(param_schemas.keys()),
                )

                # Classify blast radius
                blast_radius, destructive = classify_blast_radius_stub(
                    http_method, api_path, method_name
                )

                # Create ToolSpec
                tool = ToolSpec(
                    name=f"meraki.{resource_name}.{action}",
                    description=description or f"{method_name} in {resource_name}",
                    resource=resource_name,
                    action=action,
                    endpoint={
                        "method": http_method,
                        "path": api_path,
                    },
                    args=param_schemas,
                    required=required,
                    blast_radius=blast_radius,
                    destructive=destructive,
                    sdk_method=method_name,
                )

                tools.append(tool)

            except Exception as e:
                # Skip methods that fail introspection
                # This is expected for some internal/deprecated methods
                continue

    return tools


# Global cache for catalog
_CATALOG_CACHE: Optional[List[ToolSpec]] = None


def get_catalog() -> List[ToolSpec]:
    """
    Get cached catalog or generate it if not yet loaded.

    This function caches the catalog in memory to avoid regenerating it
    on every call. Catalog generation takes ~1-2 seconds but only happens once.

    Returns:
        List of ToolSpec objects (933 tools)
    """
    global _CATALOG_CACHE
    if _CATALOG_CACHE is None:
        _CATALOG_CACHE = generate_catalog()
    return _CATALOG_CACHE


if __name__ == "__main__":
    # Quick test: generate catalog and print summary
    catalog = generate_catalog()
    print(f"Generated {len(catalog)} tools")

    # Group by resource
    by_resource = {}
    for tool in catalog:
        by_resource.setdefault(tool.resource, []).append(tool)

    print("\nTools by resource:")
    for resource, tools in sorted(by_resource.items()):
        print(f"  {resource:20s}: {len(tools):3d} tools")

    # Show a few examples
    print("\nSample tools:")
    for tool in catalog[:5]:
        print(f"  - {tool.name}")
        print(f"    {tool.description}")
        print(f"    {tool.endpoint['method']} {tool.endpoint['path']}")
        print(f"    Blast radius: {tool.blast_radius}")
        print()
