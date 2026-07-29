"""
Sample event stream demonstration for ReACT loop.

This shows the typical event flow for a multi-step reasoning chain.
"""

import json
from unittest.mock import Mock, patch

# Sample catalog for demonstration
SAMPLE_CATALOG = [
    {
        "name": "meraki.organizations.list-organizations",
        "description": "List all organizations the user has access to",
        "resource": "organizations",
        "action": "list-organizations",
        "endpoint": {"method": "GET", "path": "/organizations"},
        "args": {},
        "required": [],
        "blast_radius": "low",
        "destructive": False,
        "sdk_method": "getOrganizations",
    },
    {
        "name": "meraki.networks.list-networks",
        "description": "List networks in an organization",
        "resource": "networks",
        "action": "list-networks",
        "endpoint": {"method": "GET", "path": "/organizations/{organizationId}/networks"},
        "args": {
            "organizationId": {"type": "string", "description": "Organization ID"}
        },
        "required": ["organizationId"],
        "blast_radius": "low",
        "destructive": False,
        "sdk_method": "getOrganizationNetworks",
    },
]


def print_event_stream():
    """
    Print a sample event stream showing typical ReACT flow.

    Scenario: User asks "How many networks do I have?"
    Agent needs to:
    1. List organizations
    2. List networks for each organization
    3. Count and respond
    """
    print("=" * 80)
    print("SAMPLE EVENT STREAM: Multi-step ReACT Loop")
    print("=" * 80)
    print()
    print("User Query: 'How many networks do I have?'")
    print()
    print("-" * 80)

    events = [
        # Step 1: Agent thinks, decides to list organizations
        {
            "type": "thought_start",
            "step": 1,
            "description": "Agent begins reasoning about how to answer the query"
        },
        {
            "type": "tool_call",
            "name": "meraki_organizations_list_organizations",
            "args": {},
            "blast_radius": "low",
            "description": "Agent calls list-organizations to find available orgs"
        },
        {
            "type": "tool_result",
            "name": "meraki_organizations_list_organizations",
            "ok": True,
            "data": [
                {"id": "123", "name": "HQ Office"},
                {"id": "456", "name": "Branch Office"}
            ],
            "meta": {
                "endpoint": {"resource": "organizations", "action": "list-organizations"},
                "blast_radius": "low",
                "duration_ms": 150
            },
            "description": "Successfully retrieved 2 organizations"
        },

        # Step 2: Agent thinks, decides to list networks for first org
        {
            "type": "thought_start",
            "step": 2,
            "description": "Agent now knows orgs, needs to count networks"
        },
        {
            "type": "tool_call",
            "name": "meraki_networks_list_networks",
            "args": {"organizationId": "123"},
            "blast_radius": "low",
            "description": "Agent lists networks for HQ Office"
        },
        {
            "type": "tool_result",
            "name": "meraki_networks_list_networks",
            "ok": True,
            "data": [
                {"id": "N_1", "name": "HQ Main", "organizationId": "123"},
                {"id": "N_2", "name": "HQ Guest", "organizationId": "123"},
                {"id": "N_3", "name": "HQ Lab", "organizationId": "123"}
            ],
            "meta": {
                "endpoint": {"resource": "networks", "action": "list-networks"},
                "blast_radius": "low",
                "duration_ms": 200
            },
            "description": "Found 3 networks in HQ Office"
        },

        # Step 3: Agent lists networks for second org
        {
            "type": "thought_start",
            "step": 3,
            "description": "Agent continues with second organization"
        },
        {
            "type": "tool_call",
            "name": "meraki_networks_list_networks",
            "args": {"organizationId": "456"},
            "blast_radius": "low",
            "description": "Agent lists networks for Branch Office"
        },
        {
            "type": "tool_result",
            "name": "meraki_networks_list_networks",
            "ok": True,
            "data": [
                {"id": "N_4", "name": "Branch Main", "organizationId": "456"},
                {"id": "N_5", "name": "Branch Guest", "organizationId": "456"}
            ],
            "meta": {
                "endpoint": {"resource": "networks", "action": "list-networks"},
                "blast_radius": "low",
                "duration_ms": 180
            },
            "description": "Found 2 networks in Branch Office"
        },

        # Step 4: Agent has all info, provides final answer
        {
            "type": "thought_start",
            "step": 4,
            "description": "Agent has gathered all data, ready to respond"
        },
        {
            "type": "final",
            "content": (
                "You have a total of 5 networks across 2 organizations:\n\n"
                "**HQ Office** (3 networks):\n"
                "- HQ Main\n"
                "- HQ Guest\n"
                "- HQ Lab\n\n"
                "**Branch Office** (2 networks):\n"
                "- Branch Main\n"
                "- Branch Guest"
            ),
            "description": "Agent provides comprehensive answer with breakdown"
        }
    ]

    for i, event in enumerate(events, 1):
        event_type = event["type"]
        description = event.pop("description", "")

        print(f"Event #{i}: {event_type.upper()}")
        if description:
            print(f"  > {description}")

        # Print event payload (excluding description)
        payload = {k: v for k, v in event.items() if k != "description"}

        if event_type == "thought_start":
            print(f"  Step: {payload['step']}")

        elif event_type == "tool_call":
            print(f"  Tool: {payload['name']}")
            print(f"  Args: {json.dumps(payload['args'], indent=2)}")
            print(f"  Blast Radius: {payload['blast_radius']}")

        elif event_type == "tool_result":
            print(f"  Tool: {payload['name']}")
            print(f"  Success: {payload['ok']}")
            if payload['ok']:
                data = payload['data']
                if isinstance(data, list):
                    print(f"  Data: {len(data)} items")
                    if len(data) > 0:
                        print(f"    Sample: {data[0]}")
                else:
                    print(f"  Data: {data}")
            else:
                print(f"  Error: {payload.get('error', {})}")
            print(f"  Duration: {payload['meta'].get('duration_ms')}ms")

        elif event_type == "final":
            print(f"  Content:")
            for line in payload['content'].split('\n'):
                print(f"    {line}")

        print()

    print("-" * 80)
    print()
    print("SUMMARY:")
    print(f"  Total events: {len(events)}")
    print(f"  Reasoning steps: {len([e for e in events if e['type'] == 'thought_start'])}")
    print(f"  Tool calls: {len([e for e in events if e['type'] == 'tool_call'])}")
    print(f"  Total API calls: 3")
    print(f"  Total duration: ~530ms")
    print()
    print("=" * 80)


if __name__ == "__main__":
    print_event_stream()
