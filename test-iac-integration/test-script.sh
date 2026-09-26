#!/bin/bash
# Complete end-to-end test script

set -e

echo "================================================"
echo "IaC Phase 1 Integration Test"
echo "Test: Push VLAN 78 via Ansible + Fanout Group"
echo "================================================"
echo ""

# Step 1: Check prerequisites
echo "Step 1: Checking prerequisites..."
if ! command -v ansible-playbook &> /dev/null; then
    echo "❌ ansible-playbook not found. Install with: pip install ansible"
    exit 1
fi
echo "✅ Ansible installed"

if ! ansible-galaxy collection list | grep -q cisco.ios; then
    echo "❌ cisco.ios collection not found. Install with: ansible-galaxy collection install cisco.ios"
    exit 1
fi
echo "✅ cisco.ios collection installed"

# Step 2: Generate inventory
echo ""
echo "Step 2: Generating inventory from fanout group..."
GROUP_NAME="${1:-production-switches}"
./generate-inventory.sh "$GROUP_NAME" > inventory.ini

if [ ! -s inventory.ini ] || ! grep -q "\[switches\]" inventory.ini; then
    echo "❌ Failed to generate inventory. Check fanout group name."
    cat inventory.ini
    exit 1
fi

DEVICE_COUNT=$(grep -c "^[0-9]" inventory.ini || echo "0")
echo "✅ Inventory generated: $DEVICE_COUNT devices"
cat inventory.ini
echo ""

# Step 3: Test connectivity
echo "Step 3: Testing connectivity (ping)..."
if ansible switches -m ping -o 2>&1 | grep -q "SUCCESS"; then
    echo "✅ Connectivity OK"
else
    echo "⚠️  Ping failed - continuing anyway (SSH might still work)"
fi
echo ""

# Step 4: Dry run
echo "Step 4: Running playbook in check mode (dry run)..."
ansible-playbook push-vlan.yml --check || {
    echo "❌ Dry run failed. Check credentials and connectivity."
    exit 1
}
echo "✅ Dry run successful"
echo ""

# Step 5: Apply changes
echo "Step 5: Applying changes..."
echo "This will:"
echo "  - Create VLAN 78 (name: test-terraform)"
echo "  - Save configuration"
echo "  - Verify VLAN exists"
echo ""
read -p "Proceed? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 0
fi

ansible-playbook push-vlan.yml || {
    echo "❌ Playbook execution failed"
    exit 1
}

echo ""
echo "✅ Playbook execution complete!"
echo ""

# Step 6: Verify in database
echo "Step 6: Verifying IaC execution in database..."
DB_PATH="$HOME/Library/Application Support/ccie-terminal/ccie.db"

if [ ! -f "$DB_PATH" ]; then
    echo "⚠️  Database not found - cannot verify"
else
    echo "Latest IaC execution:"
    sqlite3 "$DB_PATH" "
      SELECT 
        id,
        tool,
        subcommand,
        resources_changed || ' changed, ' || resources_failed || ' failed' as summary,
        datetime(created_at, 'unixepoch') as created
      FROM iac_executions 
      ORDER BY created_at DESC 
      LIMIT 1
    " -header -column
    
    echo ""
    echo "Parsed metadata:"
    sqlite3 "$DB_PATH" "
      SELECT metadata_json 
      FROM iac_executions 
      ORDER BY created_at DESC 
      LIMIT 1
    " | jq . || echo "(jq not installed - showing raw JSON)"
fi

echo ""
echo "================================================"
echo "Test Complete! ✅"
echo "================================================"
echo ""
echo "Next steps:"
echo "1. Check CCIE Terminal for enriched IaCCommandBlock rendering"
echo "2. Verify VLAN 78 on switches: ansible switches -m ios_command -a 'commands=\"show vlan id 78\"'"
echo "3. Rollback: ./test-script.sh rollback"
echo ""
