#!/bin/bash
# Simple CLI wrapper for Ansible VLAN push using CCIE Terminal vault credentials

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GROUP_NAME="${1}"
ACTION="${2:-push}"  # push or remove

if [ -z "$GROUP_NAME" ]; then
    echo "Usage: $0 <fanout-group-name> [push|remove]"
    echo ""
    echo "Example:"
    echo "  $0 production-switches push     # Add VLAN 78"
    echo "  $0 production-switches remove   # Remove VLAN 78"
    echo ""
    echo "Available fanout groups:"
    sqlite3 ~/Library/Application\ Support/ccie-terminal/ccie.db \
        "SELECT '  - ' || name FROM fanout_groups ORDER BY name"
    exit 1
fi

echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Ansible VLAN 78 Management (using CCIE Terminal vault)     ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""
echo "Group: $GROUP_NAME"
echo "Action: $ACTION"
echo ""

# Step 1: Generate inventory with credentials from vault
echo "📦 Step 1: Generating inventory from vault..."
DB_PATH="$HOME/Library/Application Support/ccie-terminal/ccie.db"

# Check if group exists
if ! sqlite3 "$DB_PATH" "SELECT 1 FROM fanout_groups WHERE name = '$GROUP_NAME'" | grep -q 1; then
    echo "❌ Error: Fanout group '$GROUP_NAME' not found"
    exit 1
fi

# Generate inventory with per-host usernames
echo "[switches]" > inventory.ini
sqlite3 "$DB_PATH" -separator " " "
  SELECT sc.host, sc.username
  FROM fanout_groups fg
  JOIN fanout_group_devices fgd ON fg.id = fgd.group_id
  JOIN ssh_connections sc ON fgd.device_id = sc.id
  WHERE fg.name = '$GROUP_NAME'
  ORDER BY sc.host
" | while read -r host username; do
    echo "$host ansible_user=$username" >> inventory.ini
done

cat >> inventory.ini << 'EOF'

[switches:vars]
ansible_network_os=ios
ansible_connection=network_cli
EOF

DEVICE_COUNT=$(grep -c "^[0-9]" inventory.ini || echo 0)
echo "✅ Inventory generated: $DEVICE_COUNT devices"
echo ""

# Step 2: Get password from vault (via CCIE Terminal CLI or prompt)
echo "🔐 Step 2: Getting credentials..."

# Try to get password from vault if ccie-terminal CLI exists
if command -v ccie-terminal &> /dev/null; then
    echo "   Using CCIE Terminal vault..."
    # This would need a CLI command to extract password
    # For now, we'll prompt
    read -s -p "Enter device password: " DEVICE_PASSWORD
    echo ""
    export ANSIBLE_NET_PASSWORD="$DEVICE_PASSWORD"
else
    # Fallback: prompt for password
    read -s -p "Enter device password: " DEVICE_PASSWORD
    echo ""
    export ANSIBLE_NET_PASSWORD="$DEVICE_PASSWORD"
fi

# Step 3: Run playbook
echo ""
echo "🚀 Step 3: Running Ansible playbook..."

if [ "$ACTION" = "remove" ]; then
    PLAYBOOK="remove-vlan.yml"
    echo "   Removing VLAN 78 from switches..."
else
    PLAYBOOK="push-vlan.yml"
    echo "   Adding VLAN 78 to switches..."
fi

cd "$SCRIPT_DIR"
ansible-playbook -i inventory.ini "$PLAYBOOK"

echo ""
echo "✅ Done! Check CCIE Terminal for enriched IaCCommandBlock display."
echo ""
echo "Verify:"
echo "  ansible switches -i inventory.ini -m ios_command -a 'commands=\"show vlan id 78\"'"
