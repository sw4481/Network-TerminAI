# IaC Phase 1: Complete Test Guide

## What This Test Does

Pushes **VLAN 78 (name: test-terraform)** to a switch group using **Ansible + your existing fanout groups**, demonstrating the new IaC Phase 1 features.

## 🎯 Expected Result

When you run `ansible-playbook`, CCIE Terminal will:

1. ✅ **Detect** the ansible-playbook command automatically
2. ✅ **Parse** the JSON output to extract task results per host
3. ✅ **Store** execution metadata in `iac_executions` table
4. ✅ **Render** an enriched **IaCCommandBlock** instead of regular terminal output

### What You'll See in the UI

**IaCCommandBlock Header:**
```
ansible-playbook -i inventory.ini push-vlan.yml
[EXIT 0] [6 tasks executed, 6 changed, 0 failed] [2.3s] [main @ a1b2c3d]
```

**Metadata Row:**
```
📁 $HOME/Network-TerminAI/test-iac-integration
🌿 main @ a1b2c3d
🕐 6:45:23 PM
```

**Collapsible Sections:**
```
▼ Changed (6 tasks)                                           [Green background]
  ⚡ ansible_task.Create VLAN 78                    → device-1.example.test
  ⚡ ansible_task.Create VLAN 78                    → device-2.example.test
  ⚡ ansible_task.Save configuration                → device-1.example.test
  ⚡ ansible_task.Save configuration                → device-2.example.test
  ...
```

---

## 🚀 Quick Start (3 Minutes)

### Prerequisites

```bash
# Install Ansible (if not already installed)
pip install ansible ansible-pylibssh

# Install Cisco IOS collection
ansible-galaxy collection install cisco.ios

# Verify installation
ansible-playbook --version
```

### Step 1: Generate Inventory from Your Fanout Group

```bash
cd test-iac-integration

# List your available fanout groups
sqlite3 ~/Library/Application\ Support/ccie-terminal/ccie.db \
  "SELECT name FROM fanout_groups"

# Generate inventory (replace 'production-switches' with your group name)
./generate-inventory.sh production-switches > inventory.ini

# Review the generated inventory
cat inventory.ini
```

**Example output:**
```ini
[switches]
device-1.example.test
device-2.example.test
device-3.example.test

[switches:vars]
ansible_network_os=ios
ansible_connection=network_cli
```

### Step 2: Set Credentials

```bash
# Export credentials (more secure than putting in inventory)
export ANSIBLE_NET_USERNAME=admin
export ANSIBLE_NET_PASSWORD=your-password

# Or use vault credentials from CCIE Terminal
# (script can be enhanced to extract from vault)
```

### Step 3: Run the Complete Test

```bash
# Automated test script (interactive)
./test-script.sh production-switches

# Or manual execution:
ansible-playbook push-vlan.yml          # Check mode first
ansible-playbook push-vlan.yml          # Apply changes
```

### Step 4: Verify in CCIE Terminal

1. Look at your terminal output - should see **IaCCommandBlock** rendering
2. Check the enriched display with badges and collapsible sections
3. Click sections to expand/collapse resource lists

### Step 5: Verify in Database

```bash
./verify-iac-features.sh
```

**Expected output:**
```
✅ iac_executions table exists
Found: 1 executions
✅ Latest execution:
   Tool: ansible
   Subcommand: playbook
   Changed: 6
   Failed: 0
```

---

## 📊 Verification Commands

### Check VLAN on Switches

```bash
# Verify VLAN exists on all switches
ansible switches -i inventory.ini -m ios_command \
  -a 'commands="show vlan id 78"'
```

### Query Database Directly

```bash
# View latest IaC execution
sqlite3 ~/Library/Application\ Support/ccie-terminal/ccie.db \
  "SELECT 
     id, tool, subcommand, 
     resources_changed, resources_failed,
     datetime(created_at, 'unixepoch') as time
   FROM iac_executions 
   ORDER BY created_at DESC 
   LIMIT 1"

# View parsed metadata (requires jq)
sqlite3 ~/Library/Application\ Support/ccie-terminal/ccie.db \
  "SELECT metadata_json FROM iac_executions ORDER BY created_at DESC LIMIT 1" \
  | jq .
```

---

## 🔄 Rollback

Remove VLAN 78 from all switches:

```bash
ansible-playbook remove-vlan.yml
```

Or manually on each switch:
```
conf t
no vlan 78
end
write mem
```

---

## 🐛 Troubleshooting

### "No devices in inventory"

**Problem:** Fanout group is empty or name is incorrect

**Solution:**
```bash
# List available groups
sqlite3 ~/Library/Application\ Support/ccie-terminal/ccie.db \
  "SELECT name, id FROM fanout_groups"

# Check group membership
sqlite3 ~/Library/Application\ Support/ccie-terminal/ccie.db \
  "SELECT sc.host FROM fanout_group_devices fgd 
   JOIN ssh_connections sc ON fgd.device_id = sc.id 
   WHERE fgd.group_id = 'YOUR-GROUP-ID'"
```

### "Authentication failed"

**Problem:** Wrong credentials or not exported

**Solution:**
```bash
# Check environment variables
echo $ANSIBLE_NET_USERNAME
echo $ANSIBLE_NET_PASSWORD

# Test with single device
ansible device-1.example.test -i inventory.ini -m ping
```

### "IaCCommandBlock not rendering"

**Problem:** IaC detection or parsing failed

**Solution:**
```bash
# Check Tauri dev console for errors
# Look for: "[IaC] Failed to process block"

# Verify command pattern matches
echo "ansible-playbook -i inventory.ini push-vlan.yml" | \
  grep -E "^(ansible-playbook|ansible\s+.+\s+-m\s+)"

# Check database for execution record
sqlite3 ~/Library/Application\ Support/ccie-terminal/ccie.db \
  "SELECT COUNT(*) FROM iac_executions"
```

### "cisco.ios collection not found"

**Problem:** Ansible Galaxy collection missing

**Solution:**
```bash
ansible-galaxy collection install cisco.ios --force
ansible-galaxy collection list | grep cisco.ios
```

---

## 🎬 Alternative: Simple Test Without Real Switches

If you don't have switches available, you can test with **localhost** and **connection: local**:

```yaml
# test-local.yml
---
- name: Test IaC detection (local execution)
  hosts: localhost
  connection: local
  gather_facts: no
  
  tasks:
    - name: Create test file
      ansible.builtin.file:
        path: /tmp/vlan-78-test
        state: touch
      
    - name: Write VLAN config
      ansible.builtin.copy:
        content: |
          vlan 78
           name test-terraform
        dest: /tmp/vlan-78-test
```

Run with:
```bash
ansible-playbook test-local.yml
```

This will:
- ✅ Trigger IaC detection
- ✅ Parse ansible output
- ✅ Show IaCCommandBlock rendering
- ✅ Store in iac_executions table

---

## 📚 Advanced Usage

### Test with Different Fanout Groups

```bash
# Production switches
./test-script.sh production-switches

# Lab environment
./test-script.sh lab-switches

# All access switches
./test-script.sh access-layer
```

### Add Variables to Playbook

```yaml
# push-vlan.yml with variables
---
- name: Push VLAN to switches
  hosts: switches
  gather_facts: no
  vars:
    vlan_id: 78
    vlan_name: test-terraform
  
  tasks:
    - name: Create VLAN {{ vlan_id }}
      cisco.ios.ios_vlan:
        vlan_id: "{{ vlan_id }}"
        name: "{{ vlan_name }}"
        state: present
```

Run with overrides:
```bash
ansible-playbook push-vlan.yml -e "vlan_id=100 vlan_name=test-100"
```

### Capture Output for Debugging

```bash
# Run with increased verbosity
ansible-playbook push-vlan.yml -vvv > /tmp/ansible-debug.log 2>&1

# Check what CCIE Terminal captured
sqlite3 ~/Library/Application\ Support/ccie-terminal/ccie.db \
  "SELECT output FROM command_blocks ORDER BY timestamp DESC LIMIT 1" \
  > /tmp/captured-output.txt
```

---

## ✅ Success Criteria

After running the test, verify:

- [ ] VLAN 78 exists on all switches in group
- [ ] IaCCommandBlock rendered (not regular command block)
- [ ] Database has 1 new iac_executions record
- [ ] Metadata JSON contains all task results
- [ ] Git branch/commit captured in UI
- [ ] Collapsible sections work (click to expand/collapse)
- [ ] Resource events show correct host mappings
- [ ] "Changed" badge shows correct count

---

## 🎯 What This Proves

This test demonstrates **all Phase 1 features working together**:

1. ✅ **Automatic detection** - No config needed, just run ansible-playbook
2. ✅ **Output parsing** - JSON callback parsed into structured events
3. ✅ **Database storage** - Execution + metadata persisted
4. ✅ **Git context** - Branch and commit captured
5. ✅ **Enriched UI** - IaCCommandBlock renders with badges and sections
6. ✅ **Multi-device support** - Works with fanout groups (via Ansible inventory)
7. ✅ **Error handling** - Failed tasks shown in red "Failed" section
8. ✅ **Integration pattern** - Uses existing block-completion hook architecture

---

## 📖 Related Documentation

- **Full feature docs:** `docs/features/iac-integration.md`
- **Architecture design:** `docs/superpowers/specs/2026-05-28-iac-integration-design.md`
- **Implementation plan:** `docs/superpowers/plans/2026-05-28-iac-phase1-interception.md`

---

## 🚀 Next Steps (Phase 2)

Once this test passes, Phase 2 can add:
- Pre-execution approval gates based on blast radius
- Terraform state browser
- Ansible inventory navigator
- ReACT agent with IaC tool integration
- Drift detection for infrastructure changes

---

**Questions? Check `README.md` for detailed walkthrough or run `./verify-iac-features.sh` to diagnose issues.**
