# Simple Commands (No Environment Variables Needed!)

## Add VLAN 78

```bash
cd "$HOME/Network-TerminAI/test-iac-integration"

# Run this ONE command (it will prompt for password)
./ansible-vlan-push.sh production-switches push
```

**That's it!** The script:
- ✅ Reads your fanout group from CCIE Terminal database
- ✅ Generates Ansible inventory with usernames automatically
- ✅ Prompts you for the device password (secure, not stored)
- ✅ Runs the playbook
- ✅ IaC features detect it and show enriched UI

---

## Remove VLAN 78

```bash
cd "$HOME/Network-TerminAI/test-iac-integration"

./ansible-vlan-push.sh production-switches remove
```

---

## List Your Fanout Groups

```bash
sqlite3 ~/Library/Application\ Support/ccie-terminal/ccie.db \
  "SELECT name FROM fanout_groups"
```

Replace `production-switches` with your actual group name.

---

## What Happens

1. **You run:** `./ansible-vlan-push.sh my-group push`
2. **Script prompts:** `Enter device password: ` (you type it once)
3. **Ansible runs:** Pushes VLAN 78 to all devices in group
4. **CCIE Terminal shows:** Enriched IaCCommandBlock with:
   - Exit code badge
   - "6 tasks executed, 6 changed" badge
   - Duration
   - Git branch/commit
   - Collapsible "Changed" section showing:
     - ⚡ Create VLAN 78 → device-1.example.test
     - ⚡ Create VLAN 78 → device-2.example.test
     - ⚡ Save config → device-1.example.test
     - etc.

---

## No Environment Variables!

The old way required:
```bash
export ANSIBLE_NET_USERNAME=admin
export ANSIBLE_NET_PASSWORD=secret
```

The new way:
- ✅ Usernames read from `ssh_connections` table
- ✅ Password prompted once (secure)
- ✅ No manual exports needed

---

## Alternative: Use --ask-pass Flag

If you prefer Ansible's built-in password prompt:

```bash
cd "$HOME/Network-TerminAI/test-iac-integration"

# Generate inventory (without password)
./generate-inventory.sh production-switches > inventory.ini

# Run with --ask-pass
ansible-playbook -i inventory.ini push-vlan.yml --ask-pass
```

Ansible will prompt: `SSH password: ` (type once, applies to all hosts)

---

## Future: GUI Integration (Phase 2)

The backend commands (`generate_ansible_inventory`, `write_ansible_inventory`) are ready for GUI integration:

**Future UI mockup:**
```
┌─────────────────────────────────────────────────┐
│ Push VLAN Configuration                         │
├─────────────────────────────────────────────────┤
│ Fanout Group: [production-switches ▼]          │
│ VLAN ID:      [78                  ]           │
│ VLAN Name:    [test-terraform      ]           │
│                                                 │
│ Playbook:     [Create VLAN         ]           │
│                                                 │
│ [Generate Inventory]  [Preview Playbook]       │
│                                                 │
│ Credentials: ✅ From vault (3 devices)         │
│                                                 │
│           [Cancel]        [Execute ▶]          │
└─────────────────────────────────────────────────┘
```

Click "Execute" → Runs ansible-playbook → IaCCommandBlock shows results

---

**That's the simplified flow!** No environment variables, no manual exports - just run the script and enter your password once.
