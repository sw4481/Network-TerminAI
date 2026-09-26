#!/usr/bin/env python3
"""
Test script for blast-radius approval flow integration.

Tests approval gating logic with live Meraki API using different tiers.
"""

import asyncio
import json
import os
import sys
from pathlib import Path

# Add sidecar to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from ccie_sidecar.agents.react import react_loop


# Sample tool catalog with different blast radius tiers
SAMPLE_CATALOG = [
    {
        "name": "meraki.organizations.list-organizations",
        "description": "List all organizations the user has access to",
        "resource": "organizations",
        "action": "list-organizations",
        "args": {},
        "required": [],
        "blast_radius": "low",
        "endpoint": {
            "method": "GET",
            "path": "/organizations"
        }
    },
    {
        "name": "meraki.networks.update-network",
        "description": "Update network configuration",
        "resource": "networks",
        "action": "update-network",
        "args": {
            "networkId": {"type": "string", "description": "Network ID"},
            "name": {"type": "string", "description": "New network name"}
        },
        "required": ["networkId"],
        "blast_radius": "high",
        "endpoint": {
            "method": "PUT",
            "path": "/networks/{networkId}"
        }
    },
    {
        "name": "meraki.networks.delete-network",
        "description": "Delete a network (irreversible)",
        "resource": "networks",
        "action": "delete-network",
        "args": {
            "networkId": {"type": "string", "description": "Network ID"}
        },
        "required": ["networkId"],
        "blast_radius": "critical",
        "endpoint": {
            "method": "DELETE",
            "path": "/networks/{networkId}"
        }
    }
]


async def test_low_tier_auto_approval():
    """Test 1: Low tier tool should auto-approve."""
    print("\n" + "="*80)
    print("TEST 1: Low tier (list-organizations) - should auto-approve")
    print("="*80)

    events = []

    def on_event(event):
        events.append(event)
        event_type = event.get('type', 'unknown')
        if event_type == 'tool_call':
            print(f"  [{event_type}] {event.get('name')} (tier: {event.get('blast_radius')})")
        elif event_type == 'tool_result':
            status = 'OK' if event.get('ok') else 'ERROR'
            approval = event.get('approval_status', 'unknown')
            print(f"  [{event_type}] {status} (approval: {approval})")
        elif event_type == 'tool_approval_request':
            print(f"  [{event_type}] APPROVAL REQUESTED - {event.get('tool_name')}")
        elif event_type == 'final':
            print(f"  [{event_type}] {event.get('content', '')[:100]}")
        elif event_type == 'error':
            print(f"  [{event_type}] {event.get('message')}")

    agent_def = {
        'id': 'test_agent_1',
        'system_prompt': 'You are a test agent. List all organizations and then say "Done."',
        'attached_tools': [{
            'catalog': json.dumps(SAMPLE_CATALOG),
            'vault_entry': 'meraki_default',
            'default_blast_radius_allowed': 'low'  # Only auto-approve reads
        }],
        'model_override': None
    }

    try:
        await react_loop(
            agent_def=agent_def,
            user_msg="List all organizations",
            ctx={},
            on_event=on_event,
            conversation_id="test_conv_1",
            db_conn=None
        )

        # Verify results
        tool_calls = [e for e in events if e['type'] == 'tool_call']
        tool_results = [e for e in events if e['type'] == 'tool_result']
        approval_requests = [e for e in events if e['type'] == 'tool_approval_request']

        print("\n  Results:")
        print(f"    - Tool calls: {len(tool_calls)}")
        print(f"    - Tool results: {len(tool_results)}")
        print(f"    - Approval requests: {len(approval_requests)}")

        if tool_results:
            for result in tool_results:
                print(f"    - Approval status: {result.get('approval_status', 'N/A')}")

        # Expected: approval_status='auto', no approval_requests
        assert len(approval_requests) == 0, "Low tier should not trigger approval request"
        if tool_results:
            assert tool_results[0].get('approval_status') == 'auto', "Should be auto-approved"
            print("\n  ✅ Test 1 PASSED: Low tier auto-approved without user intervention")
        else:
            print("\n  ⚠️  Test 1 INCOMPLETE: No tool results (check ANTHROPIC_API_KEY and MERAKI_API_KEY)")

    except Exception as e:
        print(f"\n  ❌ Test 1 FAILED: {e}")


async def test_high_tier_approval_required():
    """Test 2: High tier tool should require approval."""
    print("\n" + "="*80)
    print("TEST 2: High tier (update-network) - should require approval")
    print("="*80)

    events = []

    def on_event(event):
        events.append(event)
        event_type = event.get('type', 'unknown')
        if event_type == 'tool_call':
            print(f"  [{event_type}] {event.get('name')} (tier: {event.get('blast_radius')})")
        elif event_type == 'tool_result':
            status = 'OK' if event.get('ok') else 'ERROR'
            approval = event.get('approval_status', 'unknown')
            print(f"  [{event_type}] {status} (approval: {approval})")
        elif event_type == 'tool_approval_request':
            print(f"  [{event_type}] APPROVAL REQUESTED - {event.get('tool_name')}")
        elif event_type == 'final':
            print(f"  [{event_type}] {event.get('content', '')[:100]}")
        elif event_type == 'error':
            print(f"  [{event_type}] {event.get('message')}")

    agent_def = {
        'id': 'test_agent_2',
        'system_prompt': 'You are a test agent. Try to update network N_123 with name "Test Network" and report the result.',
        'attached_tools': [{
            'catalog': json.dumps(SAMPLE_CATALOG),
            'vault_entry': 'meraki_default',
            'default_blast_radius_allowed': 'low'  # Only auto-approve reads
        }],
        'model_override': None
    }

    try:
        await react_loop(
            agent_def=agent_def,
            user_msg="Update network N_123 with name 'Test Network'",
            ctx={},
            on_event=on_event,
            conversation_id="test_conv_2",
            db_conn=None
        )

        # Verify results
        tool_calls = [e for e in events if e['type'] == 'tool_call']
        tool_results = [e for e in events if e['type'] == 'tool_result']
        approval_requests = [e for e in events if e['type'] == 'tool_approval_request']

        print("\n  Results:")
        print(f"    - Tool calls: {len(tool_calls)}")
        print(f"    - Tool results: {len(tool_results)}")
        print(f"    - Approval requests: {len(approval_requests)}")

        if tool_results:
            for result in tool_results:
                print(f"    - Approval status: {result.get('approval_status', 'N/A')}")
                if not result.get('ok'):
                    print(f"    - Error: {result.get('error', {}).get('message', 'N/A')}")

        # Expected: approval_status='denied', approval_request emitted
        assert len(approval_requests) > 0, "High tier should trigger approval request"
        if tool_results:
            # Find results for high-tier tools
            high_tier_results = [r for r in tool_results if r.get('approval_status') == 'denied']
            if high_tier_results:
                assert not high_tier_results[0].get('ok'), "Denied approval should fail execution"
                print("\n  ✅ Test 2 PASSED: High tier triggered approval request and was denied")
            else:
                print("\n  ⚠️  Test 2 PARTIAL: Approval requested but no denied result found")
        else:
            print("\n  ⚠️  Test 2 INCOMPLETE: No tool results")

    except Exception as e:
        print(f"\n  ❌ Test 2 FAILED: {e}")


async def test_critical_tier_denial():
    """Test 3: Critical tier tool should be denied."""
    print("\n" + "="*80)
    print("TEST 3: Critical tier (delete-network) - should require approval and be denied")
    print("="*80)

    events = []

    def on_event(event):
        events.append(event)
        event_type = event.get('type', 'unknown')
        if event_type == 'tool_call':
            print(f"  [{event_type}] {event.get('name')} (tier: {event.get('blast_radius')})")
        elif event_type == 'tool_result':
            status = 'OK' if event.get('ok') else 'ERROR'
            approval = event.get('approval_status', 'unknown')
            error_code = event.get('error', {}).get('code', 'N/A') if not event.get('ok') else 'N/A'
            print(f"  [{event_type}] {status} (approval: {approval}, error: {error_code})")
        elif event_type == 'tool_approval_request':
            print(f"  [{event_type}] APPROVAL REQUESTED - {event.get('tool_name')}")
        elif event_type == 'final':
            print(f"  [{event_type}] {event.get('content', '')[:100]}")
        elif event_type == 'error':
            print(f"  [{event_type}] {event.get('message')}")

    agent_def = {
        'id': 'test_agent_3',
        'system_prompt': 'You are a test agent. Try to delete network N_456 and report the result.',
        'attached_tools': [{
            'catalog': json.dumps(SAMPLE_CATALOG),
            'vault_entry': 'meraki_default',
            'default_blast_radius_allowed': 'medium'  # Allow low and medium, not high/critical
        }],
        'model_override': None
    }

    try:
        await react_loop(
            agent_def=agent_def,
            user_msg="Delete network N_456",
            ctx={},
            on_event=on_event,
            conversation_id="test_conv_3",
            db_conn=None
        )

        # Verify results
        tool_calls = [e for e in events if e['type'] == 'tool_call']
        tool_results = [e for e in events if e['type'] == 'tool_result']
        approval_requests = [e for e in events if e['type'] == 'tool_approval_request']

        print("\n  Results:")
        print(f"    - Tool calls: {len(tool_calls)}")
        print(f"    - Tool results: {len(tool_results)}")
        print(f"    - Approval requests: {len(approval_requests)}")

        if tool_results:
            for result in tool_results:
                print(f"    - Approval status: {result.get('approval_status', 'N/A')}")
                if not result.get('ok'):
                    print(f"    - Error code: {result.get('error', {}).get('code', 'N/A')}")

        # Expected: approval_status='denied', error_code='approval_denied'
        assert len(approval_requests) > 0, "Critical tier should trigger approval request"
        if tool_results:
            critical_results = [r for r in tool_results if r.get('approval_status') == 'denied']
            if critical_results:
                assert not critical_results[0].get('ok'), "Denied should fail"
                assert critical_results[0].get('error', {}).get('code') == 'approval_denied', "Should have approval_denied error"
                print("\n  ✅ Test 3 PASSED: Critical tier triggered approval, was denied, and did not execute")
            else:
                print("\n  ⚠️  Test 3 PARTIAL: Approval requested but no denied result found")
        else:
            print("\n  ⚠️  Test 3 INCOMPLETE: No tool results")

    except Exception as e:
        print(f"\n  ❌ Test 3 FAILED: {e}")


async def main():
    """Run all approval flow tests."""
    print("\n" + "="*80)
    print("BLAST-RADIUS APPROVAL FLOW TEST SUITE")
    print("="*80)

    # Check required environment variables
    meraki_key = os.getenv("MERAKI_API_KEY")
    anthropic_key = os.getenv("ANTHROPIC_API_KEY")

    if not meraki_key:
        print("\n❌ ERROR: MERAKI_API_KEY not set")
        print("   Export MERAKI_API_KEY to run these tests")
        return

    if not anthropic_key:
        print("\n❌ ERROR: ANTHROPIC_API_KEY not set")
        print("   Export ANTHROPIC_API_KEY to run these tests")
        return

    # Run tests
    await test_low_tier_auto_approval()
    await test_high_tier_approval_required()
    await test_critical_tier_denial()

    print("\n" + "="*80)
    print("TEST SUITE COMPLETE")
    print("="*80 + "\n")


if __name__ == "__main__":
    asyncio.run(main())
