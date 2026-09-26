#!/bin/bash
# Generate Ansible inventory from CCIE Terminal fanout group

set -e

GROUP_NAME="${1:-production-switches}"
DB_PATH="$HOME/Library/Application Support/ccie-terminal/sessions.db"

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

# Generate inventory
echo "# Generated from fanout group: $GROUP_NAME"
echo "# $(date)"
echo ""
echo "[switches]"

# Everything is in sessions.db
sqlite3 "$DB_PATH" "
  SELECT DISTINCT sc.host
  FROM fanout_groups fg
  JOIN fanout_group_members fgm ON fg.id = fgm.group_id
  JOIN ssh_connections sc ON fgm.device_id = sc.id
  WHERE fg.name = '$GROUP_NAME' AND fgm.device_kind = 'ssh'
  ORDER BY sc.host
"

echo ""
echo "[switches:vars]"
echo "ansible_network_os=ios"
echo "ansible_connection=network_cli"
echo "# Set credentials via:"
echo "# export ANSIBLE_NET_USERNAME=admin"
echo "# export ANSIBLE_NET_PASSWORD=your-password"
