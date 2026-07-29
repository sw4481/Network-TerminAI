# Subnet Calculator - Design Specification

**Date:** 2026-06-24  
**Status:** Approved  
**Migration:** V0058 (next free after CML integration)

## Overview

Add a comprehensive subnet calculator as a dedicated tab type in CCIE Terminal. The calculator provides six integrated tools for subnet design, analysis, and validation - from basic CIDR calculations to VLSM design and visualization.

### User Requirements

- **Use case:** Both quick lookups AND subnet design/planning work
- **Feature scope:** Comprehensive toolkit (CIDR, splitting, VLSM, supernetting, IP checker, visualizer)
- **Integration:** Light integration - copy/paste friendly, no deep workflow integration
- **Usage frequency:** Occasional use (a few times per week)
- **Persistence:** None - fresh state on each tab open

### Success Criteria

- Fast access via keyboard shortcut (⌘⇧C)
- All six tools working with accurate calculations
- Copy-to-clipboard on all results
- Clean, professional UI matching CCIE Terminal aesthetic
- No backend dependencies - all calculations in browser
- 80%+ test coverage on calculation logic

---

## Architecture

### UI Layout

Three-column layout optimized for comprehensive feature set:

```
┌─────────────────────────────────────────────────────────────┐
│  Subnet Calculator Tab                                   ⓘ ✕ │
├───────────┬─────────────────────────────┬───────────────────┤
│           │                             │                   │
│  Feature  │      Main Workspace         │   Quick           │
│  Sidebar  │                             │   Reference       │
│           │   [Active tool renders      │   Panel           │
│  • CIDR   │    here based on sidebar    │                   │
│  • Split  │    selection]               │   • CIDR Chart    │
│  • VLSM   │                             │   • RFC1918       │
│  • Super  │                             │   • Common        │
│  • Check  │                             │     Masks         │
│  • Visual │                             │                   │
│           │                             │                   │
└───────────┴─────────────────────────────┴───────────────────┘
  ~180px           Flexible (grows)             ~240px
```

**Key Decisions:**

- **Left sidebar:** Feature switcher (vertical stack of 6 buttons)
- **Center workspace:** Active tool renders here, maximum space for complex features
- **Right reference panel:** Collapsible quick-reference (toggle button in top-right)
- **No persistence:** Fresh state on each tab open
- **Copy-friendly:** Every result includes a copy button

### Component Structure

```
src/components/subnet/
├── SubnetTab.tsx              # Main tab component, layout orchestrator
├── SubnetTab.css              # Tab-specific styles
├── FeatureSidebar.tsx         # Left sidebar with 6 tool buttons
├── QuickReference.tsx         # Right panel (collapsible)
├── tools/
│   ├── CidrCalculator.tsx     # Tool #1: Basic CIDR calculation
│   ├── SubnetSplitter.tsx     # Tool #2: Split network into N subnets
│   ├── VlsmDesigner.tsx       # Tool #3: Variable-length subnet design
│   ├── SupernettingTool.tsx   # Tool #4: Aggregate contiguous subnets
│   ├── IpChecker.tsx          # Tool #5: Check if IP is in subnet
│   └── SubnetVisualizer.tsx   # Tool #6: Visual diagrams
├── shared/
│   ├── ResultCard.tsx         # Reusable result display component
│   ├── CopyButton.tsx         # Copy-to-clipboard button
│   ├── IpInput.tsx            # Validated IP/CIDR input field
│   └── BinaryDisplay.tsx      # Binary representation component
└── SubnetTab.test.tsx         # Unit tests
```

### State Management

**No Zustand store needed.** Each tool manages its own local state with `useState` since:
- No persistence required
- No cross-feature state sharing
- No cross-tab communication needed

**Props flow:**
```typescript
SubnetTab (orchestrator)
  ├─> FeatureSidebar: { activeFeature, onFeatureChange }
  ├─> ActiveToolComponent: { /* tool-specific props */ }
  └─> QuickReference: { isOpen, onToggle }
```

### Calculation Library

Pure TypeScript functions (no backend):

```typescript
// src/lib/subnetCalculations.ts

export interface NetworkInfo {
  network: string;
  broadcast: string;
  firstUsable: string;
  lastUsable: string;
  usableHosts: number;
  subnetMask: string;
  wildcardMask: string;
  cidr: number;
  binary: {
    network: string;
    mask: string;
  };
}

export function parseCidr(input: string): { ip: string; prefix: number };
export function calculateNetwork(ip: string, prefix: number): NetworkInfo;
export function splitSubnet(network: string, parts: number): NetworkInfo[];
export function designVlsm(parent: string, reqs: Requirement[]): VlsmResult;
export function supernet(subnets: string[]): SupernetResult;
export function checkIpInSubnet(ip: string, subnet: string): boolean;
```

All calculations run client-side for instant results.

---

## Feature Specifications

### 1. CIDR Calculator (Default View)

**Purpose:** Quick subnet information lookup.

**Inputs:**
- IP address and mask in any format:
  - `192.168.1.0/24`
  - `192.168.1.0 255.255.255.0`
  - `192.168.1.0 /24`

**Outputs (in a card):**
- Network address (blue highlight)
- Broadcast address (orange highlight)
- First usable / Last usable (green highlight)
- Usable host count
- Subnet mask (CIDR, dotted decimal, hex)
- Wildcard mask
- Binary representation (collapsible section)
- Copy button for each value

**UI:**
- Clean form at top with single input field + Calculate button
- Results render in color-coded card below
- Auto-calculate on Enter key
- Show helpful examples in placeholder text

**Validation:**
- Red border + inline error for invalid IP
- Warning (don't block) if host bits are set (e.g., `192.168.1.5/24`)
- Suggest network address: "Did you mean 192.168.1.0/24?"

---

### 2. Subnet Splitter

**Purpose:** Divide a parent network into equal-sized subnets.

**Inputs:**
- Parent network (e.g., `10.0.0.0/8`)
- **Either:** Number of subnets needed (4, 8, 16, etc.)
- **Or:** New prefix length (/10, /11, etc.)

**Outputs:**
- Table of resulting subnets with columns:
  - Subnet # | Network | Broadcast | Usable Range | Host Count
- Pagination controls if > 50 subnets
- "Copy All as CSV" button + individual copy buttons per row
- Visual utilization bar: "Using 64 of 256 possible /24 subnets"

**UI:**
- Radio button toggle: "Split by count" vs "Split by prefix"
- Results in a virtualized table (react-window) for large splits
- Color-alternate rows for readability

**Validation:**
- Error if requesting more subnets than possible
- Example: "Cannot split /24 into 1024 subnets (max is 256)"

---

### 3. VLSM Designer

**Purpose:** Design variable-length subnet allocations based on host requirements.

**Inputs:**
- Parent network (e.g., `10.1.0.0/16`)
- List of requirements (add/remove rows):
  - Name (e.g., "Servers", "Workstations", "DMZ")
  - Number of hosts needed

**Interaction:**
- "Add Requirement" button to add rows
- Remove button (×) on each row
- Drag handles to reorder (affects allocation order)
- Auto-calculate button updates allocations

**Algorithm:**
- Sort requirements by size (largest first)
- Allocate smallest subnet that fits each requirement
- Show remaining address space

**Outputs:**
- Allocated subnets table:
  - Name | Hosts Needed | Subnet Allocated | Actual Hosts | Utilization %
- Visual allocation chart (horizontal bars)
- Remaining unallocated space shown
- "Export as CSV" button

**Validation:**
- Error if total requirements exceed parent capacity
- Show red highlight on rows that can't be satisfied
- Warning if utilization is poor (e.g., asking for 100 hosts gets a /24 with 254)

**Example:**
```
Parent: 10.1.0.0/16

Requirements:
- Servers: 500 hosts → 10.1.0.0/23 (510 hosts, 98% util)
- Workstations: 200 hosts → 10.1.2.0/24 (254 hosts, 79% util)
- DMZ: 50 hosts → 10.1.3.0/26 (62 hosts, 81% util)

Remaining: 10.1.3.64/26 through 10.1.255.255/16
```

---

### 4. Supernetting Tool

**Purpose:** Aggregate contiguous subnets into a single supernet.

**Inputs:**
- List of subnets (one per line in textarea, or paste from clipboard)
- Example: `192.168.0.0/24`, `192.168.1.0/24`

**Outputs:**
- Supernet (shortest prefix that contains all inputs)
- Verification section: shows which input subnets are covered
- Warning messages for common issues

**Validation:**
- **Non-contiguous:** "Subnets must be adjacent to aggregate"
- **Misaligned:** "Subnets must align on supernet boundary"
- Example: `192.168.0.0/24` + `192.168.2.0/24` → Error (gap at .1.0/24)

**Example:**
```
Input:
  192.168.0.0/24
  192.168.1.0/24
  192.168.2.0/24
  192.168.3.0/24

Output:
  Supernet: 192.168.0.0/22
  ✓ All 4 subnets are covered
```

---

### 5. IP Checker

**Purpose:** Test if an IP address belongs to a subnet.

**Inputs:**
- IP address (e.g., `192.168.1.50`)
- Subnet (e.g., `192.168.1.0/24`)

**Outputs:**
- ✓ In subnet / ✗ Not in subnet (large visual indicator)
- Position info: "IP 192.168.1.50 is host #50 of 254 usable hosts"
- Percentage through range: "19.7% through usable range"

**Batch Mode:**
- Toggle to "Batch Check" mode
- Paste list of IPs (one per line)
- Results table: IP | In Subnet | Position

**UI:**
- Green checkmark / red X with large text
- Helpful context even on failure: "IP 10.0.0.1 is not in 192.168.0.0/16"

---

### 6. Subnet Visualizer

**Purpose:** Visual diagrams for understanding subnet structure.

**Visualization Types:**

**A) Bit Diagram:**
- Shows network/host bit boundary
- Color-coded: network bits (blue), host bits (green)
- Toggle view: Binary / Hex / Decimal

**B) Address Space Bar:**
- Horizontal bar showing subnet's position in parent
- Example: Visualize where 10.1.0.0/24 sits within 10.0.0.0/16

**C) VLSM Tree:**
- Import a VLSM design from Tool #3
- Shows hierarchical allocation as a tree diagram
- Expandable nodes

**D) Utilization Chart:**
- For a list of allocated subnets, show utilization %
- Bar chart with color coding (green = good, yellow = wasteful, red = over)

**Implementation:**
- SVG-based diagrams (not ASCII art)
- Responsive sizing
- Export as PNG button (html2canvas)

---

## Integration Points

### Menu Integration

Add to the **File → New** submenu:

```
File
  └─ New
      ├─ Terminal            (existing)
      ├─ API Client          (existing)
      ├─ NETCONF Session     (existing)
      └─ Subnet Calculator   ⌘⇧C  [NEW]
```

**Keyboard shortcut:** ⌘⇧C (C for Calculator)

**Verification:** Checked existing shortcuts - ⌘⇧C is currently unused.

### Tab Management

**New Tauri command:**

```rust
// src-tauri/src/commands.rs

#[tauri::command]
pub async fn tab_new_subnet(opts: NewTabOpts, state: State<'_, AppState>) -> Result<Tab, String> {
    let mut conn = state.db.lock().await;
    let tab = db::tabs::create_tab(&mut conn, db::tabs::CreateTabOpts {
        title: opts.title,
        tab_type: "subnet".to_string(),
        ..Default::default()
    })?;
    Ok(tab)
}
```

**Frontend wrapper:**

```typescript
// src/lib/tauri.ts

export async function tabNewSubnet(opts: { title: string }): Promise<Tab> {
  return invoke<Tab>("tab_new_subnet", { opts });
}
```

**Event listener in App.tsx:**

```typescript
// src/App.tsx

unlistens.push(listen('menu:subnet_new', async () => {
  const tab = await tabNewSubnet({ title: "Subnet Calculator" });
  addTab(tab);
}));
```

**Tab rendering:**

```typescript
// src/App.tsx (in the tab content switch statement)

{tab.type === 'subnet' && (
  <Suspense fallback={<div>Loading...</div>}>
    <SubnetTab tab={tab} />
  </Suspense>
)}
```

### Database Schema

**No new tables needed.** Subnet tabs are just regular tabs with `type = 'subnet'`. No persistence of calculation state required.

### Native Menu

**Add menu item:**

```rust
// src-tauri/src/menu.rs (or wherever menu is defined)

let subnet_calculator = MenuItem::with_id(
    &app,
    "subnet_new",
    "Subnet Calculator",
    true,
    Some("CmdOrCtrl+Shift+C")
)?;

file_menu.append(&subnet_calculator)?;
```

---

## Error Handling & Validation

### Input Validation

**IP Address Validation:**
- Accept formats: `192.168.1.0/24`, `192.168.1.0 255.255.255.0`, `192.168.1.0 /24`
- Real-time validation with inline error messages
- Red border + error icon on invalid input
- Helpful error text:
  - "Invalid IP address format"
  - "CIDR prefix must be between 0 and 32"
  - "Invalid subnet mask (must be contiguous 1s)"

**Host Bits Validation:**
- Warn (don't block) if IP has host bits set
- Example: `192.168.1.5/24` → "⚠ Host bits are set. Did you mean 192.168.1.0/24?"
- Auto-suggest button to fix

**Subnet Mask Validation:**
- Verify mask is valid (contiguous 1s followed by 0s)
- Reject invalid masks like `255.255.240.15`

### Tool-Specific Validation

**VLSM Designer:**
- Check total requirements don't exceed parent capacity
- Show error: "Requirements need 1000 hosts but 192.168.1.0/24 only has 254 available"
- Highlight requirements that can't be satisfied in red

**Supernetting:**
- Detect non-contiguous subnets: "Subnets must be adjacent to aggregate"
- Detect misaligned subnets: "Cannot aggregate - alignment mismatch"
- Show which subnets are causing the error

**Subnet Splitter:**
- Error if requesting more subnets than mathematically possible
- Example: "Cannot split /24 into 1024 subnets (maximum is 256 /32s)"

### Edge Cases

**Special Prefix Lengths:**
- `/32` networks: Show "0 usable hosts (single host address)"
- `/31` networks (RFC 3021): Show warning "Point-to-point link (RFC 3021)" but allow
- `/0` network: Show "Entire IPv4 address space (0.0.0.0/0)"

**Empty States:**
- Each tool shows a helpful prompt when no input provided
- Example: "Enter an IP address and subnet mask to begin"
- Show example inputs: `[Example: 192.168.1.0/24]`

### Error Display

**Inline validation errors:**
- Red border on invalid input
- Error icon (⚠) next to field
- Error message below field in red text
- Clear on valid input

**Calculation errors:**
- Toast notification for non-field errors
- Example: "Could not aggregate subnets - see warnings below"

---

## Testing Strategy

### Unit Tests (vitest)

**Calculation library tests:**

```typescript
// src/lib/subnetCalculations.test.ts

describe('parseCidr', () => {
  it('parses CIDR notation', () => {
    expect(parseCidr('192.168.1.0/24')).toEqual({ ip: '192.168.1.0', prefix: 24 });
  });
  
  it('parses dotted decimal mask', () => {
    expect(parseCidr('192.168.1.0 255.255.255.0')).toEqual({ ip: '192.168.1.0', prefix: 24 });
  });
  
  it('throws on invalid input', () => {
    expect(() => parseCidr('not-an-ip')).toThrow();
  });
});

describe('calculateNetwork', () => {
  it('calculates /24 network correctly', () => {
    const result = calculateNetwork('192.168.1.100', 24);
    expect(result.network).toBe('192.168.1.0');
    expect(result.broadcast).toBe('192.168.1.255');
    expect(result.firstUsable).toBe('192.168.1.1');
    expect(result.lastUsable).toBe('192.168.1.254');
    expect(result.usableHosts).toBe(254);
  });
  
  it('handles /32 correctly', () => {
    const result = calculateNetwork('10.0.0.1', 32);
    expect(result.usableHosts).toBe(0);
  });
  
  it('handles /31 correctly', () => {
    const result = calculateNetwork('10.0.0.0', 31);
    expect(result.usableHosts).toBe(2); // RFC 3021
  });
});

describe('splitSubnet', () => {
  it('splits /24 into 4 /26s', () => {
    const result = splitSubnet('192.168.1.0/24', 4);
    expect(result).toHaveLength(4);
    expect(result[0].network).toBe('192.168.1.0');
    expect(result[0].cidr).toBe(26);
    expect(result[3].network).toBe('192.168.1.192');
  });
  
  it('throws when split is impossible', () => {
    expect(() => splitSubnet('192.168.1.0/24', 1000)).toThrow();
  });
});

describe('designVlsm', () => {
  it('allocates largest requirements first', () => {
    const result = designVlsm('10.0.0.0/16', [
      { name: 'Small', hosts: 50 },
      { name: 'Large', hosts: 500 },
    ]);
    expect(result.allocations[0].name).toBe('Large');
    expect(result.allocations[0].subnet).toMatch(/^10\.0\.0\.0\//);
  });
});

describe('supernet', () => {
  it('aggregates contiguous /24s into /23', () => {
    const result = supernet(['192.168.0.0/24', '192.168.1.0/24']);
    expect(result.supernet).toBe('192.168.0.0/23');
    expect(result.valid).toBe(true);
  });
  
  it('detects non-contiguous subnets', () => {
    const result = supernet(['192.168.0.0/24', '192.168.2.0/24']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not contiguous');
  });
});

describe('checkIpInSubnet', () => {
  it('returns true for IP in subnet', () => {
    expect(checkIpInSubnet('192.168.1.50', '192.168.1.0/24')).toBe(true);
  });
  
  it('returns false for IP outside subnet', () => {
    expect(checkIpInSubnet('192.168.2.1', '192.168.1.0/24')).toBe(false);
  });
});
```

**Component tests:**

```typescript
// src/components/subnet/SubnetTab.test.tsx

describe('SubnetTab', () => {
  it('renders without crashing', () => {
    render(<SubnetTab tab={mockTab} />);
    expect(screen.getByText('Subnet Calculator')).toBeInTheDocument();
  });
  
  it('switches tools when sidebar clicked', () => {
    render(<SubnetTab tab={mockTab} />);
    fireEvent.click(screen.getByText('Split'));
    expect(screen.getByText('Parent Network')).toBeInTheDocument();
  });
});

describe('CidrCalculator', () => {
  it('calculates network on form submit', async () => {
    render(<CidrCalculator />);
    const input = screen.getByPlaceholderText(/Enter IP/);
    fireEvent.change(input, { target: { value: '192.168.1.0/24' } });
    fireEvent.click(screen.getByText('Calculate'));
    
    await waitFor(() => {
      expect(screen.getByText('192.168.1.0')).toBeInTheDocument();
      expect(screen.getByText('192.168.1.255')).toBeInTheDocument();
    });
  });
  
  it('shows error for invalid input', () => {
    render(<CidrCalculator />);
    const input = screen.getByPlaceholderText(/Enter IP/);
    fireEvent.change(input, { target: { value: 'not-an-ip' } });
    fireEvent.blur(input);
    
    expect(screen.getByText(/Invalid IP address/)).toBeInTheDocument();
  });
});

describe('CopyButton', () => {
  it('copies text to clipboard', async () => {
    const writeText = vi.fn();
    Object.assign(navigator, { clipboard: { writeText } });
    
    render(<CopyButton text="192.168.1.0" />);
    fireEvent.click(screen.getByRole('button'));
    
    expect(writeText).toHaveBeenCalledWith('192.168.1.0');
  });
});
```

### Integration Tests

**Manual verification:**
- Create subnet calculator tab via menu
- Create subnet calculator tab via ⌘⇧C shortcut
- Close tab and verify cleanup
- Open multiple calculator tabs simultaneously

**Performance tests:**
- Split /16 into /24 (256 subnets) - should render in < 1s
- VLSM design with 50 requirements - should allocate in < 500ms
- Virtualized table scrolling with 1000 subnets - should be smooth

### Coverage Target

- **Calculation library:** 90%+ coverage (pure functions, deterministic)
- **Components:** 70%+ coverage (smoke tests + critical paths)
- **Overall:** 80%+ coverage

---

## Accessibility & UX Polish

### Keyboard Navigation

- **Tab key:** Moves through all inputs and buttons in logical order
- **Enter key:** Submits forms (Calculate, Add Requirement, etc.)
- **Escape key:** Closes the reference panel if open
- **Arrow keys:** Navigate results tables (when focused)
- **Cmd+K:** Opens command palette (consistent with API Tab pattern)

### Screen Reader Support

- **ARIA labels:** All inputs have descriptive labels
  - Example: `<input aria-label="IP address with subnet mask" />`
- **Error announcements:** Use `aria-live="polite"` on error containers
- **Result announcements:** Use `aria-live="polite"` on result cards
- **Copy feedback:** Announce "Copied to clipboard" to screen readers

### Visual Feedback

**Loading States:**
- Show spinner for calculations taking > 200ms (e.g., large splits)
- Disable Calculate button while processing
- Loading text: "Calculating..." or "Splitting network..."

**Success Animations:**
- Copy button: Briefly change to checkmark icon (✓) for 1 second
- Form submission: Subtle fade-in on result cards

**Smooth Transitions:**
- Tool switching: 200ms fade transition between tools
- Reference panel: 300ms slide animation when opening/closing
- Error states: 150ms fade-in on error messages

**Disabled States:**
- Gray out Calculate button until inputs are valid
- Cursor: not-allowed on disabled buttons
- Reduced opacity (0.5) on disabled elements

### Color & Contrast

**Result Highlighting:**
- Network address: `#3b82f6` (blue) with white text
- Broadcast address: `#f97316` (orange) with white text
- Usable range: `#10b981` (green) with white text
- Background contrast ratio: 4.5:1 minimum (WCAG AA)

**Error States:**
- Red border: `#ef4444`
- Error text: `#dc2626`
- Error icon: `⚠` in red

**Dark Mode Support:**
- Inherit from CCIE Terminal's existing dark mode
- Ensure all colors have sufficient contrast in both themes

### Performance Optimizations

**Large Tables:**
- Use `react-window` for virtualization when > 100 rows
- Render only visible rows + buffer
- Example: Splitting /16 into /24 (256 subnets) - only render ~20 at a time

**Input Debouncing:**
- Wait 300ms after typing before validating
- Prevents excessive re-renders during typing
- Use `useDebouncedValue` hook

**Memoization:**
- Use `useMemo` for expensive calculations
- Example: Binary representation, VLSM allocation
- Prevents recalculating on unrelated state changes

**Code Splitting:**
- Lazy load each tool component
- Example: `const CidrCalculator = lazy(() => import('./tools/CidrCalculator'))`
- Reduces initial bundle size

---

## Visual Design

### Typography

- **Headings:** System font (matching CCIE Terminal)
- **Inputs:** Monospace font for IP addresses and subnets
- **Results:** Monospace for IPs, system font for labels
- **Font sizes:**
  - Tool title: 24px
  - Section headers: 18px
  - Input labels: 14px
  - Result values: 16px monospace

### Spacing

- **Sidebar padding:** 16px
- **Tool content padding:** 24px
- **Card padding:** 20px
- **Input margins:** 12px between fields
- **Button margins:** 8px between buttons

### Cards

```css
.result-card {
  background: var(--card-bg);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}
```

### Buttons

**Primary Button (Calculate, Add, etc.):**
```css
.btn-primary {
  background: #3b82f6;
  color: white;
  padding: 8px 16px;
  border-radius: 6px;
  font-weight: 500;
  border: none;
  cursor: pointer;
}

.btn-primary:hover {
  background: #2563eb;
}
```

**Copy Button:**
```css
.btn-copy {
  background: transparent;
  border: 1px solid var(--border-color);
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.btn-copy:hover {
  background: var(--hover-bg);
}
```

### Quick Reference Panel

**Content:**
- **CIDR Chart:** /8 through /32 with host counts
- **RFC1918 Ranges:**
  - 10.0.0.0/8 (16,777,216 hosts)
  - 172.16.0.0/12 (1,048,576 hosts)
  - 192.168.0.0/16 (65,536 hosts)
- **Common Subnet Masks:**
  - /24 = 255.255.255.0 (254 hosts)
  - /25 = 255.255.255.128 (126 hosts)
  - /26 = 255.255.255.192 (62 hosts)
  - /27 = 255.255.255.224 (30 hosts)
  - /28 = 255.255.255.240 (14 hosts)
  - /29 = 255.255.255.248 (6 hosts)
  - /30 = 255.255.255.252 (2 hosts)

**Styling:**
- Collapsible (toggle button in top-right: "☰ Reference")
- Sticky position (scrolls with content)
- Monospace tables for alignment

---

## Implementation Notes

### Dependencies

**New Dependencies:**
```json
{
  "react-window": "^1.8.10",          // Virtual scrolling for large tables
  "html2canvas": "^1.4.1"             // Export visualizations as PNG
}
```

**Existing Dependencies (already in project):**
```json
{
  "react": "^18.x",
  "typescript": "^5.x",
  "vitest": "^1.x"
}
```

### File Checklist

**Frontend:**
- [ ] `src/components/subnet/SubnetTab.tsx`
- [ ] `src/components/subnet/SubnetTab.css`
- [ ] `src/components/subnet/FeatureSidebar.tsx`
- [ ] `src/components/subnet/QuickReference.tsx`
- [ ] `src/components/subnet/tools/CidrCalculator.tsx`
- [ ] `src/components/subnet/tools/SubnetSplitter.tsx`
- [ ] `src/components/subnet/tools/VlsmDesigner.tsx`
- [ ] `src/components/subnet/tools/SupernettingTool.tsx`
- [ ] `src/components/subnet/tools/IpChecker.tsx`
- [ ] `src/components/subnet/tools/SubnetVisualizer.tsx`
- [ ] `src/components/subnet/shared/ResultCard.tsx`
- [ ] `src/components/subnet/shared/CopyButton.tsx`
- [ ] `src/components/subnet/shared/IpInput.tsx`
- [ ] `src/components/subnet/shared/BinaryDisplay.tsx`
- [ ] `src/lib/subnetCalculations.ts`
- [ ] `src/lib/subnetCalculations.test.ts`
- [ ] `src/components/subnet/SubnetTab.test.tsx`
- [ ] Update `src/App.tsx` (tab rendering + event listener)
- [ ] Update `src/lib/tauri.ts` (add `tabNewSubnet`)

**Backend:**
- [ ] Update `src-tauri/src/commands.rs` (add `tab_new_subnet`)
- [ ] Update `src-tauri/src/menu.rs` (add menu item + shortcut)

**Tests:**
- [ ] Calculation library unit tests (90%+ coverage)
- [ ] Component smoke tests (70%+ coverage)
- [ ] Manual integration test checklist

### Migration

**V0058** (next free after CML integration V0057):
- No database schema changes needed
- Subnet tabs use existing `tabs` table with `type = 'subnet'`

---

## Success Metrics

### Functional Requirements

- ✅ All six tools implemented and functional
- ✅ Accurate calculations verified against known test cases
- ✅ Copy-to-clipboard on all results
- ✅ Keyboard shortcut (⌘⇧C) creates new tab
- ✅ Menu item ("File → New → Subnet Calculator")
- ✅ Multiple tabs can be open simultaneously
- ✅ No persistence (fresh state on tab open)

### Quality Metrics

- ✅ 80%+ test coverage overall
- ✅ 90%+ test coverage on calculation library
- ✅ All inputs validated with helpful error messages
- ✅ Accessible (keyboard navigation + screen reader support)
- ✅ Performance: Large calculations (256+ subnets) render in < 1s
- ✅ Visual design consistent with CCIE Terminal aesthetic

### User Experience

- ✅ Clean, uncluttered interface
- ✅ Monospace fonts for technical values
- ✅ Color-coded results (network/broadcast/usable)
- ✅ Quick reference panel always accessible
- ✅ Smooth transitions and loading states
- ✅ Dark mode support

---

## Future Enhancements (Out of Scope)

These are NOT included in the initial implementation but could be considered later:

1. **IPv6 Support:** All calculations are currently IPv4-only
2. **Persistence:** Save calculation history or favorite designs
3. **Deep Integration:** Auto-detect subnets from topology or configs
4. **Export Formats:** Beyond CSV - PDF reports, Visio diagrams
5. **Templates:** Saved VLSM templates (e.g., "Branch Office Standard")
6. **Collaboration:** Share subnet designs with team
7. **What-If Analysis:** Compare multiple VLSM allocation strategies
8. **Conflict Detection:** Check if subnet overlaps with existing allocations from topology

---

## Design Rationale

### Why a Dedicated Tab?

**Considered alternatives:**
- Modal dialog (too constrained for visualizer and VLSM designer)
- Command palette integration (doesn't fit comprehensive feature set)
- Sidebar panel (not enough space for complex tools)

**Decision:** Dedicated tab provides:
- Full screen real estate for comprehensive features
- Consistent with existing specialized tools (Topology, IaC Studio, Vault)
- Natural fit for "workspace-style" interactions (VLSM design, visualization)
- Out of the way when not needed (occasional use pattern)

### Why No Persistence?

**User requirement:** Occasional use (a few times per week) + light integration (copy/paste).

**Rationale:**
- Simpler implementation (no state management, no database)
- Faster development (no schema design, no migration)
- Fresh state prevents stale data confusion
- Copy-to-clipboard is the integration point (not saved history)

**Trade-off accepted:** Users need to redo calculations if they close the tab. Given occasional use, this is acceptable.

### Why Client-Side Calculations?

**Rationale:**
- No backend dependencies = faster, more reliable
- Instant results (no network latency)
- Works offline
- Subnet math is deterministic and lightweight

**Trade-off:** Cannot leverage server for complex calculations, but subnet math is simple enough for browser.

---

## Risks & Mitigations

### Risk: Performance with Large Splits

**Scenario:** User tries to split /8 into /24 (65,536 subnets).

**Mitigation:**
- Virtualize tables with react-window (render only visible rows)
- Add pagination (show 100 per page by default)
- Show warning: "This will generate 65,536 subnets. Consider a smaller split or use filters."
- Debounce calculations (don't recalculate on every keystroke)

### Risk: Browser Compatibility

**Scenario:** Older browsers don't support `navigator.clipboard` API.

**Mitigation:**
- Feature detection: Check if clipboard API is available
- Fallback: Use `document.execCommand('copy')` (deprecated but widely supported)
- Show error message if both fail: "Copy failed. Please manually select and copy."

### Risk: Calculation Bugs

**Scenario:** Edge cases in subnet math produce incorrect results.

**Mitigation:**
- Comprehensive unit tests (90%+ coverage on calculation library)
- Test against known subnet calculators (verify results match)
- Test edge cases: /0, /31, /32, RFC1918 boundaries
- Code review focused on bit manipulation logic

### Risk: UI Complexity

**Scenario:** Six tools in one interface feels overwhelming.

**Mitigation:**
- Default to simplest tool (CIDR Calculator)
- Clear sidebar navigation (large icons + labels)
- Each tool is self-contained (no cross-tool dependencies)
- Quick reference panel provides context without cluttering workspace

---

## Open Questions

None - all requirements clarified during brainstorming.

---

## Approval

**Design Approved:** 2026-06-24  
**Ready for Implementation:** Yes

Next step: Create implementation plan via writing-plans skill.
