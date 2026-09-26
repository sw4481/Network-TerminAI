#!/usr/bin/env python3
"""
Unit tests for approval logic without requiring API keys.

Tests the tier checking and approval flow logic in isolation.
"""

import sys
from pathlib import Path

# Add sidecar to path
sys.path.insert(0, str(Path(__file__).parent / "src"))

from ccie_sidecar.approvals import is_tier_allowed


def test_tier_hierarchy():
    """Test that tier checking works correctly."""
    print("\n" + "="*80)
    print("TEST: Tier Hierarchy Logic")
    print("="*80)

    test_cases = [
        # (tool_tier, default_allowed, expected_result, description)
        ('low', 'low', True, "Low tool with low default should auto-approve"),
        ('low', 'medium', True, "Low tool with medium default should auto-approve"),
        ('low', 'high', True, "Low tool with high default should auto-approve"),
        ('low', 'critical', True, "Low tool with critical default should auto-approve"),

        ('medium', 'low', False, "Medium tool with low default should require approval"),
        ('medium', 'medium', True, "Medium tool with medium default should auto-approve"),
        ('medium', 'high', True, "Medium tool with high default should auto-approve"),

        ('high', 'low', False, "High tool with low default should require approval"),
        ('high', 'medium', False, "High tool with medium default should require approval"),
        ('high', 'high', True, "High tool with high default should auto-approve"),
        ('high', 'critical', True, "High tool with critical default should auto-approve"),

        ('critical', 'low', False, "Critical tool with low default should require approval"),
        ('critical', 'medium', False, "Critical tool with medium default should require approval"),
        ('critical', 'high', False, "Critical tool with high default should require approval"),
        ('critical', 'critical', True, "Critical tool with critical default should auto-approve"),

        ('unknown', 'critical', False, "Unknown tier should require approval"),
    ]

    passed = 0
    failed = 0

    for tool_tier, default_allowed, expected, description in test_cases:
        result = is_tier_allowed(tool_tier, default_allowed)
        status = "✅ PASS" if result == expected else "❌ FAIL"

        if result == expected:
            passed += 1
        else:
            failed += 1
            print(f"  {status}: {description}")
            print(f"      Expected: {expected}, Got: {result}")

    print(f"\n  Results: {passed} passed, {failed} failed")

    if failed == 0:
        print("  ✅ All tier hierarchy tests passed!")
    else:
        print(f"  ❌ {failed} tests failed")

    return failed == 0


def test_audit_log_output():
    """Test that audit logging produces output."""
    print("\n" + "="*80)
    print("TEST: Audit Logging")
    print("="*80)

    from ccie_sidecar.approvals import log_tool_call

    print("  Logging a test tool call...")

    log_tool_call(
        conversation_id="test_conv",
        agent_id="test_agent",
        tool_name="meraki.organizations.list-organizations",
        method="GET",
        path="/organizations",
        args={},
        blast_radius="low",
        approval_status="auto",
        result={"ok": True, "data": []},
        duration_ms=123,
        db_conn=None
    )

    print("  ✅ Audit log generated (check console output above)")
    return True


def main():
    """Run all unit tests."""
    print("\n" + "="*80)
    print("APPROVAL LOGIC UNIT TEST SUITE")
    print("="*80)

    all_passed = True

    # Test 1: Tier hierarchy
    if not test_tier_hierarchy():
        all_passed = False

    # Test 2: Audit logging
    if not test_audit_log_output():
        all_passed = False

    print("\n" + "="*80)
    if all_passed:
        print("✅ ALL TESTS PASSED")
    else:
        print("❌ SOME TESTS FAILED")
    print("="*80 + "\n")

    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
