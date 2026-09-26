# Manual Topology Ingestion Guide

## Problem

The topology auto-ingestion feature was designed for **Blocks mode**, where each command creates a discrete block with a completion hook. However, SSH sessions must use **Terminal mode** for real-time interactive operation (vim, telnet, password prompts, etc.), which means automatic topology detection doesn't work.

## Solution: Manual Ingestion via Context Menu

You can now manually ingest topology data from Terminal mode using a right-click context menu.

## How to Use

### Step 1: Run a Topology Discovery Command

In your SSH session (Terminal mode), run any supported topology command:

```
show cdp neigh
show cdp neighbors detail
show lldp neighbors
show ip bgp summary
show ip ospf neighbor
show isis neighbors
```

**Note**: Abbreviated commands are fully supported (e.g., `show cdp neigh` works just like `show cdp neighbors`).

### Step 2: Select the Command and Output

1. Use your mouse to **select the entire output** including the command line itself
2. The selection should include:
   - The command you typed (e.g., `show cdp neigh`)
   - All the output from the device

**Example selection:**
```
ISE-OnPrem#show cdp neigh
Capability Codes: R - Router, T - Trans Bridge, B - Source Route Bridge
                  S - Switch, H - Host, I - IGMP, r - Repeater, P - Phone,
                  D - Remote, C - CVTA, M - Two-port Mac Relay

Device ID        Local Intrfce     Holdtime    Capability  Platform  Port ID
388479476200     Gig 1/0/44        157                   S  MS390-24U Ten 1/0/12
2c3f0b047580     Gig 1/0/48        159                   S  MS390-24U Port 11
localhost        Gig 1/0/2         150                   S  VMware ES vmnic5
SDA-2800         Gig 1/0/6         155                 R T  AIR-AP280 Gig 0

Total cdp entries displayed : 4
ISE-OnPrem#
```

### Step 3: Right-Click and Select "Ingest Topology"

1. **Right-click** on the selected text
2. The context menu will appear
3. If a topology command is detected in your selection (within the first 5 lines), you'll see:
   - **🗺️ Ingest Topology** option

The context menu item is labeled **🗺️ Ingest Topology**.

4. Click **"🗺️ Ingest Topology"**

### Step 4: Confirmation

You'll see one of two notifications:

**✅ Success:**
```
✅ Topology ingested successfully!

Open the Topology tab (⌘K → "Topology") to view the graph.
```

**❌ Error:**
```
❌ Topology ingestion failed:
[Error details]
```

Common errors:
- **"No topology command found in selection"**: Make sure you included the command line (`show cdp neigh`) in your selection
- **"Cannot determine tab information"**: The tab metadata is missing; try reconnecting
- **Parsing errors**: The output format may not match expected patterns for your vendor/platform

### Step 5: View the Topology Graph

1. Press **⌘K** (Command Palette)
2. Type "Topology"
3. Select **"Topology — Open Global View"**

You should now see your discovered neighbors as nodes in the interactive graph.

## Tips

### Include the Command Line

Always select from the command prompt through the end of the output:

✅ **Good:**
```
ISE-OnPrem#show cdp neigh
[... output ...]
ISE-OnPrem#
```

❌ **Bad:**
```
Capability Codes: R - Router...
[... output without command ...]
```

### Multi-Protocol Discovery

You can run and ingest multiple discovery protocols:

1. Run `show cdp neigh` → right-click, ingest
2. Run `show lldp neigh` → right-click, ingest

The topology graph will show edges for both CDP and LLDP with different visual styles.

### Vendor/Platform Detection

The ingestion uses the tab's vendor and platform settings:
- Vendor: cisco, juniper, arista, meraki, etc.
- Platform: iosxe, nxos, junos, etc.

If these aren't set correctly, parsing may fail. The system defaults to `cisco/iosxe` if unset.

## Limitations

- **Selection-based**: You must manually select and ingest output (not automatic)
- **Vendor detection**: Relies on tab metadata; may default to cisco/iosxe
- **Single command per selection**: Each selection should contain one topology command
- **No streaming**: You must wait for the command to complete before selecting

## Future Improvements

Potential enhancements tracked in the roadmap:

- **Smart prompt detection**: Automatically detect command boundaries in Terminal mode
- **Auto-ingest on prompt return**: Trigger ingestion when a new prompt appears after a topology command
- **Visual indicator**: Show a "📊" icon next to parseable output
- **Batch ingestion**: Select multiple commands at once

## Troubleshooting

### "No topology command found in selection"

**Cause**: The command line wasn't included in the selection, or the command doesn't match the supported patterns.

**Solution**: Ensure your selection starts from the line containing `show cdp neigh` (or similar).

### Parser errors

**Cause**: The output format doesn't match what the parser expects for your vendor/platform.

**Solution**:
1. Check that your device vendor/platform is correctly set
2. Try the `show ... detail` variant (e.g., `show cdp neighbors detail`)
3. Report parsing issues to the dev team with a sample of your output

### Graph doesn't update

**Cause**: You may already be viewing the Topology tab when you ingest.

**Solution**: Click the **⟳ Refresh** button in the Topology tab toolbar.

## See Also

- [TOPOLOGY.md](./TOPOLOGY.md) - Main topology architecture documentation
- [Command Blocks](COMMAND_BLOCKS.md) - Using Blocks mode and command history
