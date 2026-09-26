#!/bin/bash
# Generate Ansible inventory from fanout group WITH credentials from CCIE Terminal

set -e

GROUP_NAME="${1:-production-switches}"
OUTPUT_FILE="${2:-inventory.ini}"
DB_PATH="$HOME/Library/Application Support/ccie-terminal/ccie.db"

if [ ! -f "$DB_PATH" ]; then
    echo "Error: CCIE Terminal database not found at $DB_PATH" >&2
    exit 1
fi

# Check if group exists
GROUP_COUNT=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM fanout_groups WHERE name = '$GROUP_NAME'")
if [ "$GROUP_COUNT" -eq 0 ]; then
    echo "Error: Fanout group '$GROUP_NAME' not found" >&2
    echo "Available groups:" >&2
    sqlite3 "$DB_PATH" "SELECT name FROM fanout_groups ORDER BY name" >&2
    exit 1
fi

echo "# Generated from fanout group: $GROUP_NAME" > "$OUTPUT_FILE"
echo "# $(date)" >> "$OUTPUT_FILE"
echo "" >> "$OUTPUT_FILE"

echo "[switches]" >> "$OUTPUT_FILE"

# Get devices with their individual credentials
sqlite3 "$DB_PATH" -separator " " "
  SELECT
    sc.host,
    sc.username,
    sc.encrypted_password
  FROM fanout_groups fg
  JOIN fanout_group_devices fgd ON fg.id = fgd.group_id
  JOIN ssh_connections sc ON fgd.device_id = sc.id
  WHERE fg.name = '$GROUP_NAME'
  ORDER BY sc.host
" | while read -r host username encrypted_password; do
    # Note: encrypted_password needs vault unlock to decrypt
    # For now, we'll use ansible_user per-host and rely on ssh-agent or vault prompt
    echo "$host ansible_user=$username" >> "$OUTPUT_FILE"
done

echo "" >> "$OUTPUT_FILE"
echo "[switches:vars]" >> "$OUTPUT_FILE"
echo "ansible_network_os=ios" >> "$OUTPUT_FILE"
echo "ansible_connection=network_cli" >> "$OUTPUT_FILE"
echo "# Credentials: Using per-host ansible_user from ssh_connections" >> "$OUTPUT_FILE"
echo "# Password: Will prompt from vault or use ansible-vault encrypted file" >> "$OUTPUT_FILE"

echo ""
echo "✅ Inventory generated: $OUTPUT_FILE"
echo "📊 Devices: $(grep -c "^[0-9]" "$OUTPUT_FILE" || echo 0)"
echo ""
echo "Next: Set password for all devices:"
echo "  export ANSIBLE_NET_PASSWORD=\$(ccie-vault get-password)"
echo "Or: ansible-playbook -i $OUTPUT_FILE push-vlan.yml --ask-pass"
