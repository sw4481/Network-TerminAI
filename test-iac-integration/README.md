# IaC Phase 1 Integration Test

This directory contains a complete end-to-end test for the IaC integration features.

## Test: Push VLAN 78 to Switch Group using Ansible

### Prerequisites

1. **Ansible installed:**
   ```bash
   pip install ansible ansible-pylibssh
   ansible-galaxy collection install cisco.ios
   ```

2. **Fanout group exists** in CCIE Terminal named "production-switches"

3. **SSH credentials** configured in vault/environment

### Test Steps

#### 1. Generate Inventory from Fanout Group

```bash
./generate-inventory.sh production-switches > inventory.ini
```

This queries your CCIE Terminal database and exports the fanout group as an Ansible inventory.

#### 2. Run Ansible Playbook

```bash
# Dry run (check mode)
ansible-playbook -i inventory.ini push-vlan.yml --check

# Apply changes
ansible-playbook -i inventory.ini push-vlan.yml
```

#### 3. Verify IaC Features

**Expected behavior in CCIE Terminal:**

1. ✅ Command block for `ansible-playbook` appears
2. ✅ IaCCommandBlock component renders (not regular block)
3. ✅ Header shows:
   - Exit code badge (green if successful)
   - "X tasks executed, Y changed, Z failed" badge
   - Duration
   - Git branch (if in git repo)
4. ✅ Collapsible sections:
   - **Changed** section (green) with:
     - Task: "Create VLAN 78" → each host listed
     - Task: "Save config" → each host listed
5. ✅ Each task shows host as `resource_id`
6. ✅ Database record in `iac_executions` table

### Verification Queries

```bash
# Check database record
sqlite3 ~/Library/Application\ Support/ccie-terminal/ccie.db \
  "SELECT id, tool, subcommand, resources_changed, resources_failed 
   FROM iac_executions 
   ORDER BY created_at DESC LIMIT 1"

# View parsed metadata
sqlite3 ~/Library/Application\ Support/ccie-terminal/ccie.db \
  "SELECT metadata_json 
   FROM iac_executions 
   ORDER BY created_at DESC LIMIT 1" | jq .
```

### Expected Output

```json
{
  "resourcesChanged": 6,
  "resourcesFailed": 0,
  "resourceEvents": [
    {
      "resource_type": "ansible_task",
      "resource_name": "Create VLAN 78",
      "resource_id": "device-1.example.test",
      "action": "Changed",
      "timestamp": 1735776000,
      "error": null
    },
    ...
  ],
  "summary": "6 tasks executed, 6 changed, 0 failed"
}
```

## Alternative: Terraform Test (Single Device)

See `terraform-test/` for Terraform provider example (single device only).

## Rollback

To remove VLAN 78:

```bash
ansible-playbook -i inventory.ini remove-vlan.yml
```

Or manually:
```
conf t
no vlan 78
end
write memory
```
