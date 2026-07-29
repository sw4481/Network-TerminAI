# Subnet Calculator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a comprehensive subnet calculator as a dedicated tab type with six integrated tools for subnet design, analysis, and visualization.

**Architecture:** Three-column layout (feature sidebar | workspace | reference panel). All calculations run client-side in TypeScript. No persistence required - fresh state on each tab open.

**Tech Stack:** React 19, TypeScript 5.8, Vitest 4.1, react-window (virtual scrolling), html2canvas (PNG export)

## Global Constraints

- React version: ^19.1.0 (already installed)
- TypeScript version: ~5.8.3 (already installed)
- Vitest version: ^4.1.5 (already installed)
- Test coverage: 80%+ overall, 90%+ on calculation library
- No backend dependencies - all calculations in browser
- Monospace fonts for IPs/subnets
- Color-coded results: network (blue #3b82f6), broadcast (orange #f97316), usable (green #10b981)
- Keyboard shortcut: ⌘⇧C
- Migration: V0058 (no schema changes needed)
- Performance: 256 subnets render in < 1s

---

## File Structure

### Backend (Rust/Tauri)
- **Modify:** `src-tauri/src/commands/mod.rs` - Add `tab_new_subnet` command
- **Modify:** `src-tauri/src/lib.rs` - Register command in invoke_handler
- **Modify:** `src-tauri/tauri.conf.json` - Add menu item + shortcut

### Frontend Core
- **Create:** `src/lib/subnetCalculations.ts` - Pure calculation functions (IPv4 only)
- **Create:** `src/lib/subnetCalculations.test.ts` - Unit tests (90%+ coverage target)
- **Modify:** `src/lib/tauri.ts` - Add `tabNewSubnet` wrapper
- **Modify:** `src/lib/types.ts` - Add subnet tab type definitions
- **Modify:** `src/App.tsx` - Add tab rendering + menu event listener

### UI Components
- **Create:** `src/components/subnet/SubnetTab.tsx` - Main tab orchestrator
- **Create:** `src/components/subnet/SubnetTab.css` - Tab styles
- **Create:** `src/components/subnet/SubnetTab.test.tsx` - Component tests
- **Create:** `src/components/subnet/FeatureSidebar.tsx` - Left sidebar (6 tool buttons)
- **Create:** `src/components/subnet/QuickReference.tsx` - Right panel (collapsible)

### Tool Components
- **Create:** `src/components/subnet/tools/CidrCalculator.tsx` - Tool #1
- **Create:** `src/components/subnet/tools/SubnetSplitter.tsx` - Tool #2
- **Create:** `src/components/subnet/tools/VlsmDesigner.tsx` - Tool #3
- **Create:** `src/components/subnet/tools/SupernettingTool.tsx` - Tool #4
- **Create:** `src/components/subnet/tools/IpChecker.tsx` - Tool #5
- **Create:** `src/components/subnet/tools/SubnetVisualizer.tsx` - Tool #6

### Shared Components
- **Create:** `src/components/subnet/shared/ResultCard.tsx` - Reusable result display
- **Create:** `src/components/subnet/shared/CopyButton.tsx` - Copy-to-clipboard button
- **Create:** `src/components/subnet/shared/IpInput.tsx` - Validated IP/CIDR input
- **Create:** `src/components/subnet/shared/BinaryDisplay.tsx` - Binary representation

### Dependencies
- **Modify:** `package.json` - Add react-window@^1.8.10, html2canvas@^1.4.1

---

## Task 1: Add Dependencies

**Files:**
- Modify: `package.json`

**Interfaces:**
- Consumes: None (starting point)
- Produces: react-window and html2canvas available for import

- [ ] **Step 1: Add new dependencies**

```bash
cd "/Users/shaunwhi/CCIE Terminal"
npm install react-window@^1.8.10 html2canvas@^1.4.1
npm install --save-dev @types/react-window
```

Expected: Dependencies added to package.json and node_modules

- [ ] **Step 2: Verify installation**

Run: `npm list react-window html2canvas`
Expected: Both packages shown in dependency tree

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "deps: add react-window and html2canvas for subnet calculator

- react-window@^1.8.10 for virtual scrolling (large subnet tables)
- html2canvas@^1.4.1 for PNG export (visualizations)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 2: Calculation Library - Core Functions

**Files:**
- Create: `src/lib/subnetCalculations.ts`
- Create: `src/lib/subnetCalculations.test.ts`

**Interfaces:**
- Consumes: None
- Produces:
  - `parseCidr(input: string): { ip: string; prefix: number }`
  - `calculateNetwork(ip: string, prefix: number): NetworkInfo`
  - `ipToNumber(ip: string): number`
  - `numberToIp(num: number): string`

- [ ] **Step 1: Write failing tests for IP conversion**

Create `src/lib/subnetCalculations.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { ipToNumber, numberToIp, parseCidr, calculateNetwork } from './subnetCalculations';

describe('ipToNumber', () => {
  it('converts 192.168.1.1 to number', () => {
    expect(ipToNumber('192.168.1.1')).toBe(3232235777);
  });

  it('converts 10.0.0.0 to number', () => {
    expect(ipToNumber('10.0.0.0')).toBe(167772160);
  });

  it('converts 0.0.0.0 to 0', () => {
    expect(ipToNumber('0.0.0.0')).toBe(0);
  });

  it('converts 255.255.255.255 to max', () => {
    expect(ipToNumber('255.255.255.255')).toBe(4294967295);
  });
});

describe('numberToIp', () => {
  it('converts number back to IP', () => {
    expect(numberToIp(3232235777)).toBe('192.168.1.1');
  });

  it('converts 0 to 0.0.0.0', () => {
    expect(numberToIp(0)).toBe('0.0.0.0');
  });
});

describe('parseCidr', () => {
  it('parses CIDR notation', () => {
    expect(parseCidr('192.168.1.0/24')).toEqual({ ip: '192.168.1.0', prefix: 24 });
  });

  it('parses dotted decimal mask', () => {
    expect(parseCidr('192.168.1.0 255.255.255.0')).toEqual({ ip: '192.168.1.0', prefix: 24 });
  });

  it('parses with space before slash', () => {
    expect(parseCidr('192.168.1.0 /24')).toEqual({ ip: '192.168.1.0', prefix: 24 });
  });

  it('throws on invalid IP', () => {
    expect(() => parseCidr('not-an-ip')).toThrow('Invalid IP address');
  });

  it('throws on invalid prefix', () => {
    expect(() => parseCidr('192.168.1.0/33')).toThrow('CIDR prefix must be between 0 and 32');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- subnetCalculations.test.ts`
Expected: All tests FAIL with "cannot find module"

- [ ] **Step 3: Implement IP conversion functions**

Create `src/lib/subnetCalculations.ts`:

```typescript
/**
 * Subnet calculation library for IPv4.
 * All functions are pure (no side effects) for easy testing.
 */

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

/**
 * Convert IPv4 address to 32-bit number.
 * @param ip Dotted decimal IP (e.g., "192.168.1.1")
 * @returns 32-bit unsigned integer
 */
export function ipToNumber(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => p < 0 || p > 255 || isNaN(p))) {
    throw new Error(`Invalid IP address: ${ip}`);
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

/**
 * Convert 32-bit number to IPv4 address.
 * @param num 32-bit unsigned integer
 * @returns Dotted decimal IP
 */
export function numberToIp(num: number): string {
  return [
    (num >>> 24) & 0xFF,
    (num >>> 16) & 0xFF,
    (num >>> 8) & 0xFF,
    num & 0xFF,
  ].join('.');
}

/**
 * Parse CIDR notation or dotted decimal mask.
 * Accepts: "192.168.1.0/24", "192.168.1.0 255.255.255.0", "192.168.1.0 /24"
 * @param input IP with CIDR or mask
 * @returns {ip, prefix}
 */
export function parseCidr(input: string): { ip: string; prefix: number } {
  const trimmed = input.trim();
  
  // CIDR notation: 192.168.1.0/24
  const cidrMatch = trimmed.match(/^(\d+\.\d+\.\d+\.\d+)\s*\/\s*(\d+)$/);
  if (cidrMatch) {
    const ip = cidrMatch[1];
    const prefix = parseInt(cidrMatch[2], 10);
    if (prefix < 0 || prefix > 32) {
      throw new Error('CIDR prefix must be between 0 and 32');
    }
    // Validate IP format
    ipToNumber(ip);
    return { ip, prefix };
  }

  // Dotted decimal mask: 192.168.1.0 255.255.255.0
  const maskMatch = trimmed.match(/^(\d+\.\d+\.\d+\.\d+)\s+(\d+\.\d+\.\d+\.\d+)$/);
  if (maskMatch) {
    const ip = maskMatch[1];
    const mask = maskMatch[2];
    ipToNumber(ip); // Validate IP
    const maskNum = ipToNumber(mask);
    
    // Convert mask to prefix length (count leading 1s)
    let prefix = 0;
    let temp = maskNum;
    while ((temp & 0x80000000) !== 0) {
      prefix++;
      temp <<= 1;
    }
    
    // Verify mask is valid (contiguous 1s)
    const expectedMask = (0xFFFFFFFF << (32 - prefix)) >>> 0;
    if (maskNum !== expectedMask) {
      throw new Error('Invalid subnet mask (must be contiguous 1s)');
    }
    
    return { ip, prefix };
  }

  throw new Error('Invalid IP address format. Expected CIDR (192.168.1.0/24) or dotted mask (192.168.1.0 255.255.255.0)');
}

/**
 * Calculate full network information for a given IP and prefix.
 * @param ip IPv4 address
 * @param prefix CIDR prefix (0-32)
 * @returns NetworkInfo object with all calculated values
 */
export function calculateNetwork(ip: string, prefix: number): NetworkInfo {
  if (prefix < 0 || prefix > 32) {
    throw new Error('CIDR prefix must be between 0 and 32');
  }

  const ipNum = ipToNumber(ip);
  const maskNum = (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const wildcardNum = (~maskNum) >>> 0;
  
  const networkNum = (ipNum & maskNum) >>> 0;
  const broadcastNum = (networkNum | wildcardNum) >>> 0;
  
  // Usable hosts calculation
  let firstUsableNum: number;
  let lastUsableNum: number;
  let usableHosts: number;
  
  if (prefix === 32) {
    // /32 - single host, no usable range
    firstUsableNum = networkNum;
    lastUsableNum = networkNum;
    usableHosts = 0;
  } else if (prefix === 31) {
    // /31 - RFC 3021 point-to-point, both addresses usable
    firstUsableNum = networkNum;
    lastUsableNum = broadcastNum;
    usableHosts = 2;
  } else {
    // Standard: exclude network and broadcast
    firstUsableNum = networkNum + 1;
    lastUsableNum = broadcastNum - 1;
    usableHosts = Math.max(0, broadcastNum - networkNum - 1);
  }

  return {
    network: numberToIp(networkNum),
    broadcast: numberToIp(broadcastNum),
    firstUsable: numberToIp(firstUsableNum),
    lastUsable: numberToIp(lastUsableNum),
    usableHosts,
    subnetMask: numberToIp(maskNum),
    wildcardMask: numberToIp(wildcardNum),
    cidr: prefix,
    binary: {
      network: networkNum.toString(2).padStart(32, '0'),
      mask: maskNum.toString(2).padStart(32, '0'),
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- subnetCalculations.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/subnetCalculations.ts src/lib/subnetCalculations.test.ts
git commit -m "feat(subnet): add core calculation functions

Implements:
- ipToNumber / numberToIp conversion
- parseCidr for CIDR and dotted-decimal notation
- calculateNetwork for full subnet info

Tests cover edge cases: /0, /31, /32, invalid inputs

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 3: Calculation Library - Advanced Functions

**Files:**
- Modify: `src/lib/subnetCalculations.ts`
- Modify: `src/lib/subnetCalculations.test.ts`

**Interfaces:**
- Consumes: `calculateNetwork`, `parseCidr`, `ipToNumber` from Task 2
- Produces:
  - `splitSubnet(network: string, parts: number): NetworkInfo[]`
  - `checkIpInSubnet(ip: string, subnet: string): { inSubnet: boolean; position?: number; total?: number }`
  - `supernet(subnets: string[]): { supernet: string; valid: boolean; error?: string }`

- [ ] **Step 1: Write failing tests for advanced functions**

Add to `src/lib/subnetCalculations.test.ts`:

```typescript
describe('calculateNetwork', () => {
  it('calculates /24 correctly', () => {
    const result = calculateNetwork('192.168.1.100', 24);
    expect(result.network).toBe('192.168.1.0');
    expect(result.broadcast).toBe('192.168.1.255');
    expect(result.firstUsable).toBe('192.168.1.1');
    expect(result.lastUsable).toBe('192.168.1.254');
    expect(result.usableHosts).toBe(254);
    expect(result.subnetMask).toBe('255.255.255.0');
    expect(result.wildcardMask).toBe('0.0.0.255');
  });

  it('handles /32 correctly', () => {
    const result = calculateNetwork('10.0.0.1', 32);
    expect(result.usableHosts).toBe(0);
    expect(result.network).toBe('10.0.0.1');
    expect(result.broadcast).toBe('10.0.0.1');
  });

  it('handles /31 correctly (RFC 3021)', () => {
    const result = calculateNetwork('10.0.0.0', 31);
    expect(result.usableHosts).toBe(2);
    expect(result.firstUsable).toBe('10.0.0.0');
    expect(result.lastUsable).toBe('10.0.0.1');
  });

  it('handles /0 correctly', () => {
    const result = calculateNetwork('0.0.0.0', 0);
    expect(result.network).toBe('0.0.0.0');
    expect(result.broadcast).toBe('255.255.255.255');
  });
});

describe('splitSubnet', () => {
  it('splits /24 into 4 /26 subnets', () => {
    const result = splitSubnet('192.168.1.0/24', 4);
    expect(result).toHaveLength(4);
    expect(result[0].network).toBe('192.168.1.0');
    expect(result[0].cidr).toBe(26);
    expect(result[1].network).toBe('192.168.1.64');
    expect(result[2].network).toBe('192.168.1.128');
    expect(result[3].network).toBe('192.168.1.192');
  });

  it('splits /16 into 256 /24 subnets', () => {
    const result = splitSubnet('10.0.0.0/16', 256);
    expect(result).toHaveLength(256);
    expect(result[0].network).toBe('10.0.0.0');
    expect(result[255].network).toBe('10.0.255.0');
  });

  it('throws when split is impossible', () => {
    expect(() => splitSubnet('192.168.1.0/24', 1000)).toThrow('Cannot split');
  });
});

describe('checkIpInSubnet', () => {
  it('returns true for IP in subnet', () => {
    const result = checkIpInSubnet('192.168.1.50', '192.168.1.0/24');
    expect(result.inSubnet).toBe(true);
    expect(result.position).toBe(50);
    expect(result.total).toBe(254);
  });

  it('returns false for IP outside subnet', () => {
    const result = checkIpInSubnet('192.168.2.1', '192.168.1.0/24');
    expect(result.inSubnet).toBe(false);
  });

  it('handles /32 correctly', () => {
    const result = checkIpInSubnet('10.0.0.1', '10.0.0.1/32');
    expect(result.inSubnet).toBe(true);
  });
});

describe('supernet', () => {
  it('aggregates contiguous /24s into /23', () => {
    const result = supernet(['192.168.0.0/24', '192.168.1.0/24']);
    expect(result.valid).toBe(true);
    expect(result.supernet).toBe('192.168.0.0/23');
  });

  it('aggregates four /24s into /22', () => {
    const result = supernet([
      '192.168.0.0/24',
      '192.168.1.0/24',
      '192.168.2.0/24',
      '192.168.3.0/24',
    ]);
    expect(result.valid).toBe(true);
    expect(result.supernet).toBe('192.168.0.0/22');
  });

  it('detects non-contiguous subnets', () => {
    const result = supernet(['192.168.0.0/24', '192.168.2.0/24']);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('not contiguous');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- subnetCalculations.test.ts`
Expected: New tests FAIL (functions not defined)

- [ ] **Step 3: Implement advanced functions**

Add to `src/lib/subnetCalculations.ts`:

```typescript
/**
 * Split a network into N equal-sized subnets.
 * @param network CIDR notation (e.g., "192.168.1.0/24")
 * @param parts Number of subnets to create
 * @returns Array of NetworkInfo for each subnet
 */
export function splitSubnet(network: string, parts: number): NetworkInfo[] {
  const { ip, prefix } = parseCidr(network);
  
  // Calculate new prefix length
  const bitsNeeded = Math.ceil(Math.log2(parts));
  const newPrefix = prefix + bitsNeeded;
  
  if (newPrefix > 32) {
    throw new Error(`Cannot split /${prefix} into ${parts} subnets (would require /${newPrefix})`);
  }
  
  const actualParts = Math.pow(2, bitsNeeded);
  const networkNum = ipToNumber(ip) & ((0xFFFFFFFF << (32 - prefix)) >>> 0);
  const subnetSize = Math.pow(2, 32 - newPrefix);
  
  const results: NetworkInfo[] = [];
  for (let i = 0; i < actualParts; i++) {
    const subnetNum = networkNum + (i * subnetSize);
    results.push(calculateNetwork(numberToIp(subnetNum), newPrefix));
  }
  
  return results;
}

/**
 * Check if an IP address is within a subnet.
 * @param ip IPv4 address
 * @param subnet CIDR notation
 * @returns {inSubnet, position, total} - position is 1-indexed within usable range
 */
export function checkIpInSubnet(
  ip: string,
  subnet: string,
): { inSubnet: boolean; position?: number; total?: number } {
  const { ip: subnetIp, prefix } = parseCidr(subnet);
  const ipNum = ipToNumber(ip);
  const info = calculateNetwork(subnetIp, prefix);
  const networkNum = ipToNumber(info.network);
  const broadcastNum = ipToNumber(info.broadcast);
  
  const inSubnet = ipNum >= networkNum && ipNum <= broadcastNum;
  
  if (!inSubnet) {
    return { inSubnet: false };
  }
  
  // Calculate position within usable range
  if (prefix === 32) {
    return { inSubnet: true, position: 0, total: 0 };
  }
  
  const firstUsableNum = ipToNumber(info.firstUsable);
  const position = Math.max(1, ipNum - firstUsableNum + 1);
  
  return {
    inSubnet: true,
    position,
    total: info.usableHosts,
  };
}

/**
 * Aggregate contiguous subnets into a supernet.
 * @param subnets Array of CIDR notations
 * @returns {supernet, valid, error} - valid=false if aggregation impossible
 */
export function supernet(subnets: string[]): {
  supernet: string;
  valid: boolean;
  error?: string;
} {
  if (subnets.length === 0) {
    return { supernet: '', valid: false, error: 'No subnets provided' };
  }
  
  // Parse all subnets
  const parsed = subnets.map(s => {
    const { ip, prefix } = parseCidr(s);
    return { ip, prefix, num: ipToNumber(ip) };
  });
  
  // Sort by IP number
  parsed.sort((a, b) => a.num - b.num);
  
  // Find the smallest prefix that covers all
  const firstNum = parsed[0].num;
  const lastSubnet = parsed[parsed.length - 1];
  const lastInfo = calculateNetwork(lastSubnet.ip, lastSubnet.prefix);
  const lastNum = ipToNumber(lastInfo.broadcast);
  
  // Find prefix that covers from first to last
  let superPrefix = 0;
  for (let p = 0; p <= 32; p++) {
    const maskNum = (0xFFFFFFFF << (32 - p)) >>> 0;
    const superNetNum = (firstNum & maskNum) >>> 0;
    const superBroadcastNum = (superNetNum | (~maskNum >>> 0)) >>> 0;
    
    if (superBroadcastNum >= lastNum) {
      superPrefix = p;
      break;
    }
  }
  
  const maskNum = (0xFFFFFFFF << (32 - superPrefix)) >>> 0;
  const superNetNum = (firstNum & maskNum) >>> 0;
  const supernet = `${numberToIp(superNetNum)}/${superPrefix}`;
  
  // Verify all subnets are contiguous and properly aligned
  const superInfo = calculateNetwork(numberToIp(superNetNum), superPrefix);
  const superStart = ipToNumber(superInfo.network);
  const superEnd = ipToNumber(superInfo.broadcast);
  
  // Check each subnet is within supernet
  for (const sub of parsed) {
    const subInfo = calculateNetwork(sub.ip, sub.prefix);
    const subStart = ipToNumber(subInfo.network);
    const subEnd = ipToNumber(subInfo.broadcast);
    
    if (subStart < superStart || subEnd > superEnd) {
      return {
        supernet,
        valid: false,
        error: 'Subnets are not properly aligned for aggregation',
      };
    }
  }
  
  // Check for gaps (simplified check: compare total size)
  const expectedSize = superEnd - superStart + 1;
  const actualSize = parsed.reduce((sum, sub) => {
    const subInfo = calculateNetwork(sub.ip, sub.prefix);
    return sum + (ipToNumber(subInfo.broadcast) - ipToNumber(subInfo.network) + 1);
  }, 0);
  
  if (actualSize < expectedSize) {
    return {
      supernet,
      valid: false,
      error: 'Subnets are not contiguous (gaps detected)',
    };
  }
  
  return { supernet, valid: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- subnetCalculations.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/subnetCalculations.ts src/lib/subnetCalculations.test.ts
git commit -m "feat(subnet): add splitting, checking, and supernetting

Implements:
- splitSubnet: divide network into N equal subnets
- checkIpInSubnet: test IP membership with position
- supernet: aggregate contiguous subnets

All tests passing with edge cases covered

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 4: Calculation Library - VLSM Designer

**Files:**
- Modify: `src/lib/subnetCalculations.ts`
- Modify: `src/lib/subnetCalculations.test.ts`

**Interfaces:**
- Consumes: `calculateNetwork`, `parseCidr`, `ipToNumber`, `numberToIp` from previous tasks
- Produces:
  - `interface VlsmRequirement { name: string; hostsNeeded: number }`
  - `interface VlsmAllocation { name: string; hostsNeeded: number; subnet: string; actualHosts: number; utilization: number }`
  - `interface VlsmResult { allocations: VlsmAllocation[]; remainingSpace: string[]; error?: string }`
  - `designVlsm(parent: string, requirements: VlsmRequirement[]): VlsmResult`

- [ ] **Step 1: Write failing tests for VLSM**

Add to `src/lib/subnetCalculations.test.ts`:

```typescript
import type { VlsmRequirement } from './subnetCalculations';

describe('designVlsm', () => {
  it('allocates largest requirements first', () => {
    const reqs: VlsmRequirement[] = [
      { name: 'Small', hostsNeeded: 50 },
      { name: 'Large', hostsNeeded: 500 },
      { name: 'Medium', hostsNeeded: 200 },
    ];
    const result = designVlsm('10.0.0.0/16', reqs);
    
    expect(result.allocations).toHaveLength(3);
    expect(result.allocations[0].name).toBe('Large');
    expect(result.allocations[0].subnet).toMatch(/^10\.0\.0\.0\//);
    expect(result.allocations[1].name).toBe('Medium');
    expect(result.allocations[2].name).toBe('Small');
  });

  it('calculates utilization correctly', () => {
    const reqs: VlsmRequirement[] = [{ name: 'Test', hostsNeeded: 100 }];
    const result = designVlsm('192.168.1.0/24', reqs);
    
    expect(result.allocations[0].actualHosts).toBe(126); // /25 gives 126 hosts
    expect(result.allocations[0].utilization).toBeCloseTo(79.4, 1); // 100/126 * 100
  });

  it('returns error when requirements exceed capacity', () => {
    const reqs: VlsmRequirement[] = [{ name: 'TooLarge', hostsNeeded: 1000 }];
    const result = designVlsm('192.168.1.0/24', reqs);
    
    expect(result.error).toContain('exceed');
  });

  it('shows remaining space', () => {
    const reqs: VlsmRequirement[] = [{ name: 'Small', hostsNeeded: 10 }];
    const result = designVlsm('192.168.1.0/24', reqs);
    
    expect(result.remainingSpace.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- subnetCalculations.test.ts`
Expected: VLSM tests FAIL (types and function not defined)

- [ ] **Step 3: Implement VLSM types and function**

Add to `src/lib/subnetCalculations.ts`:

```typescript
export interface VlsmRequirement {
  name: string;
  hostsNeeded: number;
}

export interface VlsmAllocation {
  name: string;
  hostsNeeded: number;
  subnet: string;
  actualHosts: number;
  utilization: number;
}

export interface VlsmResult {
  allocations: VlsmAllocation[];
  remainingSpace: string[];
  error?: string;
}

/**
 * Design variable-length subnet allocation (VLSM).
 * Allocates smallest subnet that fits each requirement, largest first.
 * @param parent Parent network in CIDR notation
 * @param requirements Array of {name, hostsNeeded}
 * @returns {allocations, remainingSpace, error}
 */
export function designVlsm(
  parent: string,
  requirements: VlsmRequirement[],
): VlsmResult {
  const { ip: parentIp, prefix: parentPrefix } = parseCidr(parent);
  const parentInfo = calculateNetwork(parentIp, parentPrefix);
  const parentNum = ipToNumber(parentInfo.network);
  const parentSize = ipToNumber(parentInfo.broadcast) - parentNum + 1;
  
  // Check total requirements
  const totalNeeded = requirements.reduce((sum, r) => sum + r.hostsNeeded, 0);
  if (totalNeeded > parentInfo.usableHosts) {
    return {
      allocations: [],
      remainingSpace: [],
      error: `Requirements need ${totalNeeded} hosts but ${parent} only has ${parentInfo.usableHosts} usable hosts`,
    };
  }
  
  // Sort requirements by size (largest first)
  const sorted = [...requirements].sort((a, b) => b.hostsNeeded - a.hostsNeeded);
  
  const allocations: VlsmAllocation[] = [];
  let currentNum = parentNum;
  const parentEndNum = ipToNumber(parentInfo.broadcast);
  
  for (const req of sorted) {
    // Find smallest prefix that fits hostsNeeded
    // Need hostsNeeded + 2 (network + broadcast) total addresses
    let bestPrefix = 32;
    for (let p = 0; p <= 32; p++) {
      const testInfo = calculateNetwork(numberToIp(currentNum), p);
      if (testInfo.usableHosts >= req.hostsNeeded) {
        bestPrefix = p;
        break;
      }
    }
    
    if (bestPrefix === 32 && req.hostsNeeded > 0) {
      return {
        allocations,
        remainingSpace: [],
        error: `Cannot allocate ${req.hostsNeeded} hosts for "${req.name}"`,
      };
    }
    
    // Allocate this subnet
    const subnet = `${numberToIp(currentNum)}/${bestPrefix}`;
    const subnetInfo = calculateNetwork(numberToIp(currentNum), bestPrefix);
    const actualHosts = subnetInfo.usableHosts;
    const utilization = actualHosts > 0 ? (req.hostsNeeded / actualHosts) * 100 : 0;
    
    allocations.push({
      name: req.name,
      hostsNeeded: req.hostsNeeded,
      subnet,
      actualHosts,
      utilization,
    });
    
    // Move to next available address
    const subnetSize = ipToNumber(subnetInfo.broadcast) - currentNum + 1;
    currentNum += subnetSize;
    
    if (currentNum > parentEndNum) {
      break;
    }
  }
  
  // Calculate remaining space
  const remainingSpace: string[] = [];
  if (currentNum <= parentEndNum) {
    // Find largest prefix that fits in remaining space
    const remainingSize = parentEndNum - currentNum + 1;
    let remainingPrefix = 32;
    for (let p = 0; p <= 32; p++) {
      if (Math.pow(2, 32 - p) <= remainingSize) {
        remainingPrefix = p;
        break;
      }
    }
    remainingSpace.push(`${numberToIp(currentNum)}/${remainingPrefix} through ${numberToIp(parentEndNum)}`);
  }
  
  return { allocations, remainingSpace, error: undefined };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- subnetCalculations.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/subnetCalculations.ts src/lib/subnetCalculations.test.ts
git commit -m "feat(subnet): add VLSM designer

Implements variable-length subnet allocation:
- Sorts requirements by size (largest first)
- Allocates smallest subnet that fits each requirement
- Calculates utilization percentage
- Shows remaining unallocated space

Tests cover capacity overflow and edge cases

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 5: Backend - Tauri Command

**Files:**
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `session::Tab` type, `session::create_tab` function (existing)
- Produces: `tab_new_subnet` Tauri command registered and callable from frontend

- [ ] **Step 1: Add tab_new_subnet command**

Edit `src-tauri/src/commands/mod.rs`, add after `tab_close_netconf` (around line 770):

```rust
/// Create a Subnet Calculator tab. Like API/NETCONF tabs, this does NOT
/// spawn a PTY — it only inserts a row with `tab_type='subnet'`.
#[tauri::command]
pub fn tab_new_subnet(
    state: State<'_, AppState>,
    title: String,
) -> Result<session::Tab, String> {
    tracing::info!(title = %title, "Creating Subnet Calculator tab");
    let db = state.db.lock();
    session::create_tab(&db, &title, "subnet").map_err(|e| {
        tracing::error!(error = %e, "Failed to create subnet tab");
        e.to_string()
    })
}

/// Close a Subnet Calculator tab (no PTY, just a DB close).
#[tauri::command]
pub fn tab_close_subnet(state: State<'_, AppState>, tab_id: String) -> Result<(), String> {
    let validated = validation::validate_tab_id(&tab_id).map_err(|e| e.to_string())?;
    let db = state.db.lock();
    session::close_tab(&db, &validated).map_err(|e| e.to_string())
}
```

- [ ] **Step 2: Register commands in invoke_handler**

Edit `src-tauri/src/lib.rs`, find the `invoke_handler!` macro (around line 233) and add after `tab_close_netconf`:

```rust
commands::tab_new_subnet,
commands::tab_close_subnet,
```

- [ ] **Step 3: Build to verify compilation**

Run: `cd "/Users/shaunwhi/CCIE Terminal" && npm run tauri build -- --debug`
Expected: Build succeeds (may take 2-3 minutes)

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/commands/mod.rs src-tauri/src/lib.rs
git commit -m "feat(subnet): add Tauri commands for subnet tabs

- tab_new_subnet: creates tab with type='subnet'
- tab_close_subnet: closes subnet tab
- Registered in invoke_handler

No PTY spawned (like API/NETCONF tabs)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 6: Frontend - Tauri Wrapper and Types

**Files:**
- Modify: `src/lib/tauri.ts`
- Modify: `src/lib/types.ts`

**Interfaces:**
- Consumes: `tab_new_subnet` Tauri command from Task 5
- Produces:
  - `tabNewSubnet(opts: { title: string }): Promise<Tab>`
  - `tabCloseSubnet(tabId: string): Promise<void>`
  - Type guard: `tab.type === 'subnet'`

- [ ] **Step 1: Add subnet tab wrapper functions**

Edit `src/lib/tauri.ts`, add after `tabCloseNetconf` (around line 168):

```typescript
/**
 * Create a new Subnet Calculator tab. Does NOT spawn a PTY.
 */
export const tabNewSubnet = (opts: { title: string }) =>
  invoke<Tab>("tab_new_subnet", { title: opts.title });

/** Close a Subnet Calculator tab (no PTY, just a DB close). */
export const tabCloseSubnet = (tabId: string) =>
  invoke<void>("tab_close_subnet", { tabId });
```

- [ ] **Step 2: Verify Tab type includes 'subnet'**

Check `src/lib/types.ts` to see if `Tab` type allows `type: 'subnet'`. If the type field is a string union, add `'subnet'` to it. If it's just `type: string`, no change needed.

Example modification if needed:

```typescript
export interface Tab {
  id: string;
  title: string;
  type: 'terminal' | 'api' | 'netconf' | 'editor' | 'subnet'; // Add 'subnet'
  // ...other fields
}
```

- [ ] **Step 3: Build to verify TypeScript compilation**

Run: `npm run build:relaxed`
Expected: Build succeeds with no type errors

- [ ] **Step 4: Commit**

```bash
git add src/lib/tauri.ts src/lib/types.ts
git commit -m "feat(subnet): add frontend Tauri wrappers

- tabNewSubnet: creates subnet calculator tab
- tabCloseSubnet: closes subnet tab
- Added 'subnet' to Tab type union

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 7: Menu Integration

**Files:**
- Modify: `src-tauri/tauri.conf.json`

**Interfaces:**
- Consumes: None
- Produces: Menu item "File → New → Subnet Calculator" with ⌘⇧C shortcut, emits `menu:subnet_new` event

- [ ] **Step 1: Find menu configuration in tauri.conf.json**

Read `src-tauri/tauri.conf.json` and locate the menu configuration section. Look for where "New API Client" or "New NETCONF Session" are defined.

- [ ] **Step 2: Add Subnet Calculator menu item**

Add the subnet calculator item to the File → New submenu (exact format depends on tauri.conf.json structure, adapt as needed):

```json
{
  "id": "subnet_new",
  "title": "Subnet Calculator",
  "accelerator": "CmdOrCtrl+Shift+C"
}
```

Place it after the NETCONF Session menu item in the New submenu.

- [ ] **Step 3: Test menu in development mode**

Run: `npm run tauri dev`
Expected: Application launches, File → New → Subnet Calculator visible with ⌘⇧C shortcut

- [ ] **Step 4: Verify shortcut doesn't conflict**

In the running app, press ⌘⇧C. Expected: No action yet (event listener not wired), but no conflict with existing shortcuts.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -m "feat(subnet): add menu item and keyboard shortcut

File → New → Subnet Calculator (⌘⇧C)
Emits 'menu:subnet_new' event

No conflicts with existing shortcuts

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 8: Shared Components - CopyButton

**Files:**
- Create: `src/components/subnet/shared/CopyButton.tsx`
- Create: `src/components/subnet/shared/CopyButton.test.tsx`

**Interfaces:**
- Consumes: None
- Produces: `CopyButton({ text: string }): JSX.Element` - copies text to clipboard on click

- [ ] **Step 1: Write failing test for CopyButton**

Create `src/components/subnet/shared/CopyButton.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CopyButton } from './CopyButton';

describe('CopyButton', () => {
  beforeEach(() => {
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(() => Promise.resolve()),
      },
    });
  });

  it('renders copy button', () => {
    render(<CopyButton text="192.168.1.0" />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('copies text to clipboard on click', async () => {
    render(<CopyButton text="192.168.1.0" />);
    const button = screen.getByRole('button');
    fireEvent.click(button);
    
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('192.168.1.0');
  });

  it('shows checkmark after successful copy', async () => {
    render(<CopyButton text="test" />);
    const button = screen.getByRole('button');
    
    fireEvent.click(button);
    
    // Button should show checkmark (✓) briefly
    expect(button.textContent).toContain('✓');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- CopyButton.test.tsx`
Expected: FAIL with "cannot find module"

- [ ] **Step 3: Implement CopyButton component**

Create `src/components/subnet/shared/CopyButton.tsx`:

```typescript
import { useState } from 'react';

export interface CopyButtonProps {
  text: string;
}

export function CopyButton({ text }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      onClick={handleCopy}
      className="btn-copy"
      aria-label={`Copy ${text}`}
      title="Copy to clipboard"
    >
      {copied ? '✓' : '📋'}
    </button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- CopyButton.test.tsx`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/components/subnet/shared/CopyButton.tsx src/components/subnet/shared/CopyButton.test.tsx
git commit -m "feat(subnet): add CopyButton shared component

Copies text to clipboard on click
Shows checkmark (✓) for 1s after successful copy
Accessible with ARIA labels

Tests verify clipboard interaction

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 9: Shared Components - IpInput and ResultCard

**Files:**
- Create: `src/components/subnet/shared/IpInput.tsx`
- Create: `src/components/subnet/shared/ResultCard.tsx`
- Create: `src/components/subnet/shared/BinaryDisplay.tsx`

**Interfaces:**
- Consumes: None
- Produces:
  - `IpInput({ value, onChange, onBlur, error, placeholder }: IpInputProps): JSX.Element`
  - `ResultCard({ title, children, className }: ResultCardProps): JSX.Element`
  - `BinaryDisplay({ binary, label }: BinaryDisplayProps): JSX.Element`

- [ ] **Step 1: Create IpInput component**

Create `src/components/subnet/shared/IpInput.tsx`:

```typescript
export interface IpInputProps {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  error?: string;
  placeholder?: string;
}

export function IpInput({ value, onChange, onBlur, error, placeholder }: IpInputProps) {
  return (
    <div className="ip-input-container">
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder || '192.168.1.0/24'}
        className={`ip-input ${error ? 'ip-input-error' : ''}`}
        aria-label="IP address with subnet mask"
        aria-invalid={!!error}
        aria-describedby={error ? 'ip-input-error' : undefined}
      />
      {error && (
        <div id="ip-input-error" className="ip-input-error-text" role="alert">
          ⚠ {error}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create ResultCard component**

Create `src/components/subnet/shared/ResultCard.tsx`:

```typescript
import type { ReactNode } from 'react';

export interface ResultCardProps {
  title?: string;
  children: ReactNode;
  className?: string;
}

export function ResultCard({ title, children, className = '' }: ResultCardProps) {
  return (
    <div className={`result-card ${className}`}>
      {title && <h3 className="result-card-title">{title}</h3>}
      <div className="result-card-content">{children}</div>
    </div>
  );
}
```

- [ ] **Step 3: Create BinaryDisplay component**

Create `src/components/subnet/shared/BinaryDisplay.tsx`:

```typescript
import { useState } from 'react';

export interface BinaryDisplayProps {
  binary: string;
  label: string;
}

export function BinaryDisplay({ binary, label }: BinaryDisplayProps) {
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <button
        onClick={() => setExpanded(true)}
        className="binary-toggle"
        aria-label={`Show binary representation for ${label}`}
      >
        Show Binary
      </button>
    );
  }

  // Format binary with dots every 8 bits for readability
  const formatted = binary.match(/.{1,8}/g)?.join('.') || binary;

  return (
    <div className="binary-display">
      <div className="binary-header">
        <span className="binary-label">{label}</span>
        <button
          onClick={() => setExpanded(false)}
          className="binary-toggle"
          aria-label="Hide binary representation"
        >
          Hide
        </button>
      </div>
      <pre className="binary-value">{formatted}</pre>
    </div>
  );
}
```

- [ ] **Step 4: Build to verify components compile**

Run: `npm run build:relaxed`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/components/subnet/shared/IpInput.tsx src/components/subnet/shared/ResultCard.tsx src/components/subnet/shared/BinaryDisplay.tsx
git commit -m "feat(subnet): add shared UI components

- IpInput: validated IP/CIDR input with error display
- ResultCard: reusable card container for results
- BinaryDisplay: collapsible binary representation

All components accessible with ARIA attributes

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 10: Tool Components - CIDR Calculator

**Files:**
- Create: `src/components/subnet/tools/CidrCalculator.tsx`

**Interfaces:**
- Consumes: `parseCidr`, `calculateNetwork` from `src/lib/subnetCalculations.ts`
- Consumes: `IpInput`, `ResultCard`, `CopyButton`, `BinaryDisplay` from shared components
- Produces: `CidrCalculator(): JSX.Element` - renders CIDR calculator tool

- [ ] **Step 1: Create CIDR Calculator component**

Create `src/components/subnet/tools/CidrCalculator.tsx`:

```typescript
import { useState } from 'react';
import { parseCidr, calculateNetwork } from '../../../lib/subnetCalculations';
import { IpInput } from '../shared/IpInput';
import { ResultCard } from '../shared/ResultCard';
import { CopyButton } from '../shared/CopyButton';
import { BinaryDisplay } from '../shared/BinaryDisplay';

export function CidrCalculator() {
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReturnType<typeof calculateNetwork> | null>(null);

  const handleCalculate = () => {
    try {
      const { ip, prefix } = parseCidr(input);
      const info = calculateNetwork(ip, prefix);
      setResult(info);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid input');
      setResult(null);
    }
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleCalculate();
    }
  };

  return (
    <div className="cidr-calculator">
      <h2 className="tool-title">CIDR Calculator</h2>
      
      <div className="cidr-input-section">
        <IpInput
          value={input}
          onChange={setInput}
          error={error}
          placeholder="192.168.1.0/24 or 192.168.1.0 255.255.255.0"
        />
        <button
          onClick={handleCalculate}
          onKeyPress={handleKeyPress}
          className="btn-primary"
          disabled={!input.trim()}
        >
          Calculate
        </button>
      </div>

      {result && (
        <ResultCard title="Network Information">
          <div className="result-row network">
            <span className="result-label">Network Address:</span>
            <span className="result-value">{result.network}</span>
            <CopyButton text={result.network} />
          </div>

          <div className="result-row broadcast">
            <span className="result-label">Broadcast Address:</span>
            <span className="result-value">{result.broadcast}</span>
            <CopyButton text={result.broadcast} />
          </div>

          <div className="result-row usable">
            <span className="result-label">First Usable:</span>
            <span className="result-value">{result.firstUsable}</span>
            <CopyButton text={result.firstUsable} />
          </div>

          <div className="result-row usable">
            <span className="result-label">Last Usable:</span>
            <span className="result-value">{result.lastUsable}</span>
            <CopyButton text={result.lastUsable} />
          </div>

          <div className="result-row">
            <span className="result-label">Usable Hosts:</span>
            <span className="result-value">{result.usableHosts.toLocaleString()}</span>
            <CopyButton text={result.usableHosts.toString()} />
          </div>

          <div className="result-section">
            <h4>Subnet Mask</h4>
            <div className="result-row">
              <span className="result-label">CIDR:</span>
              <span className="result-value">/{result.cidr}</span>
            </div>
            <div className="result-row">
              <span className="result-label">Dotted Decimal:</span>
              <span className="result-value">{result.subnetMask}</span>
              <CopyButton text={result.subnetMask} />
            </div>
            <div className="result-row">
              <span className="result-label">Wildcard Mask:</span>
              <span className="result-value">{result.wildcardMask}</span>
              <CopyButton text={result.wildcardMask} />
            </div>
          </div>

          <div className="result-section">
            <BinaryDisplay binary={result.binary.network} label="Network (Binary)" />
            <BinaryDisplay binary={result.binary.mask} label="Subnet Mask (Binary)" />
          </div>
        </ResultCard>
      )}

      {!result && !error && (
        <div className="empty-state">
          <p>Enter an IP address and subnet mask to begin</p>
          <p className="empty-state-example">Example: 192.168.1.0/24</p>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Build to verify component compiles**

Run: `npm run build:relaxed`
Expected: Build succeeds

- [ ] **Step 3: Commit**

```bash
git add src/components/subnet/tools/CidrCalculator.tsx
git commit -m "feat(subnet): add CIDR Calculator tool

First of six tools:
- Input validation with helpful error messages
- Full network information display (network, broadcast, usable range)
- Subnet mask in multiple formats (CIDR, dotted, wildcard)
- Binary representation (collapsible)
- Copy buttons on all values

Enter key triggers calculation

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 11: Tool Components - Subnet Splitter and IP Checker

**Files:**
- Create: `src/components/subnet/tools/SubnetSplitter.tsx`
- Create: `src/components/subnet/tools/IpChecker.tsx`

**Interfaces:**
- Consumes: Calculation functions from `src/lib/subnetCalculations.ts`, shared components
- Produces: `SubnetSplitter(): JSX.Element`, `IpChecker(): JSX.Element`

- [ ] **Step 1: Create SubnetSplitter component**

Create `src/components/subnet/tools/SubnetSplitter.tsx`:

```typescript
import { useState } from 'react';
import { parseCidr, splitSubnet } from '../../../lib/subnetCalculations';
import type { NetworkInfo } from '../../../lib/subnetCalculations';
import { IpInput } from '../shared/IpInput';
import { CopyButton } from '../shared/CopyButton';

export function SubnetSplitter() {
  const [parentNetwork, setParentNetwork] = useState('');
  const [parts, setParts] = useState('4');
  const [error, setError] = useState('');
  const [results, setResults] = useState<NetworkInfo[]>([]);

  const handleSplit = () => {
    try {
      const partsNum = parseInt(parts, 10);
      if (isNaN(partsNum) || partsNum < 2) {
        setError('Number of subnets must be at least 2');
        return;
      }
      
      const subnets = splitSubnet(parentNetwork, partsNum);
      setResults(subnets);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid input');
      setResults([]);
    }
  };

  const handleCopyAll = () => {
    const csv = results.map((r, i) => 
      `${i + 1},${r.network}/${r.cidr},${r.broadcast},${r.firstUsable} - ${r.lastUsable},${r.usableHosts}`
    ).join('\n');
    const header = 'Subnet #,Network,Broadcast,Usable Range,Host Count\n';
    navigator.clipboard.writeText(header + csv);
  };

  return (
    <div className="subnet-splitter">
      <h2 className="tool-title">Subnet Splitter</h2>
      
      <div className="splitter-inputs">
        <div className="input-group">
          <label htmlFor="parent-network">Parent Network</label>
          <IpInput
            value={parentNetwork}
            onChange={setParentNetwork}
            error={error}
            placeholder="10.0.0.0/8"
          />
        </div>

        <div className="input-group">
          <label htmlFor="parts">Number of Subnets</label>
          <input
            id="parts"
            type="number"
            value={parts}
            onChange={(e) => setParts(e.target.value)}
            min="2"
            className="number-input"
          />
        </div>

        <button onClick={handleSplit} className="btn-primary" disabled={!parentNetwork.trim()}>
          Split Network
        </button>
      </div>

      {results.length > 0 && (
        <div className="splitter-results">
          <div className="results-header">
            <h3>{results.length} Subnets</h3>
            <button onClick={handleCopyAll} className="btn-secondary">
              Copy All as CSV
            </button>
          </div>

          <table className="results-table">
            <thead>
              <tr>
                <th>#</th>
                <th>Network</th>
                <th>Broadcast</th>
                <th>Usable Range</th>
                <th>Hosts</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {results.map((result, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td className="monospace">{result.network}/{result.cidr}</td>
                  <td className="monospace">{result.broadcast}</td>
                  <td className="monospace">{result.firstUsable} - {result.lastUsable}</td>
                  <td>{result.usableHosts}</td>
                  <td>
                    <CopyButton text={`${result.network}/${result.cidr}`} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create IpChecker component**

Create `src/components/subnet/tools/IpChecker.tsx`:

```typescript
import { useState } from 'react';
import { checkIpInSubnet } from '../../../lib/subnetCalculations';
import { IpInput } from '../shared/IpInput';
import { ResultCard } from '../shared/ResultCard';

export function IpChecker() {
  const [ipAddress, setIpAddress] = useState('');
  const [subnet, setSubnet] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReturnType<typeof checkIpInSubnet> | null>(null);

  const handleCheck = () => {
    try {
      const checkResult = checkIpInSubnet(ipAddress, subnet);
      setResult(checkResult);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid input');
      setResult(null);
    }
  };

  return (
    <div className="ip-checker">
      <h2 className="tool-title">IP Checker</h2>
      
      <div className="checker-inputs">
        <div className="input-group">
          <label htmlFor="ip-address">IP Address</label>
          <IpInput
            value={ipAddress}
            onChange={setIpAddress}
            placeholder="192.168.1.50"
          />
        </div>

        <div className="input-group">
          <label htmlFor="subnet-input">Subnet</label>
          <IpInput
            value={subnet}
            onChange={setSubnet}
            error={error}
            placeholder="192.168.1.0/24"
          />
        </div>

        <button 
          onClick={handleCheck} 
          className="btn-primary"
          disabled={!ipAddress.trim() || !subnet.trim()}
        >
          Check
        </button>
      </div>

      {result && (
        <ResultCard>
          <div className={`check-result ${result.inSubnet ? 'in-subnet' : 'not-in-subnet'}`}>
            <div className="check-icon">
              {result.inSubnet ? '✓' : '✗'}
            </div>
            <div className="check-text">
              {result.inSubnet ? (
                <>
                  <h3>IP is in subnet</h3>
                  {result.position !== undefined && result.total !== undefined && (
                    <p>
                      Host #{result.position} of {result.total} usable hosts
                      <br />
                      ({((result.position / result.total) * 100).toFixed(1)}% through range)
                    </p>
                  )}
                </>
              ) : (
                <>
                  <h3>IP is NOT in subnet</h3>
                  <p>{ipAddress} is not in {subnet}</p>
                </>
              )}
            </div>
          </div>
        </ResultCard>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Build to verify components compile**

Run: `npm run build:relaxed`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/components/subnet/tools/SubnetSplitter.tsx src/components/subnet/tools/IpChecker.tsx
git commit -m "feat(subnet): add SubnetSplitter and IpChecker tools

SubnetSplitter:
- Divides parent network into N equal subnets
- Results table with copy buttons
- Copy All as CSV export

IpChecker:
- Tests if IP is in subnet
- Shows position within usable range
- Large visual indicator (✓/✗)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 12: Tool Components - VLSM Designer, Supernetting, and Visualizer

**Files:**
- Create: `src/components/subnet/tools/VlsmDesigner.tsx`
- Create: `src/components/subnet/tools/SupernettingTool.tsx`
- Create: `src/components/subnet/tools/SubnetVisualizer.tsx`

**Interfaces:**
- Consumes: `designVlsm`, `supernet` from calculation library, shared components
- Produces: `VlsmDesigner()`, `SupernettingTool()`, `SubnetVisualizer()` components

- [ ] **Step 1: Create VlsmDesigner component**

Create `src/components/subnet/tools/VlsmDesigner.tsx`:

```typescript
import { useState } from 'react';
import { designVlsm } from '../../../lib/subnetCalculations';
import type { VlsmRequirement } from '../../../lib/subnetCalculations';
import { IpInput } from '../shared/IpInput';
import { CopyButton } from '../shared/CopyButton';

export function VlsmDesigner() {
  const [parentNetwork, setParentNetwork] = useState('');
  const [requirements, setRequirements] = useState<VlsmRequirement[]>([
    { name: '', hostsNeeded: 0 },
  ]);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ReturnType<typeof designVlsm> | null>(null);

  const addRequirement = () => {
    setRequirements([...requirements, { name: '', hostsNeeded: 0 }]);
  };

  const removeRequirement = (index: number) => {
    setRequirements(requirements.filter((_, i) => i !== index));
  };

  const updateRequirement = (index: number, field: keyof VlsmRequirement, value: string | number) => {
    const updated = [...requirements];
    updated[index] = { ...updated[index], [field]: value };
    setRequirements(updated);
  };

  const handleDesign = () => {
    try {
      const validReqs = requirements.filter(r => r.name && r.hostsNeeded > 0);
      if (validReqs.length === 0) {
        setError('Add at least one requirement');
        return;
      }
      
      const vlsmResult = designVlsm(parentNetwork, validReqs);
      setResult(vlsmResult);
      setError(vlsmResult.error || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid input');
      setResult(null);
    }
  };

  const handleExportCsv = () => {
    if (!result) return;
    
    const csv = result.allocations.map(a =>
      `${a.name},${a.hostsNeeded},${a.subnet},${a.actualHosts},${a.utilization.toFixed(1)}%`
    ).join('\n');
    const header = 'Name,Hosts Needed,Subnet Allocated,Actual Hosts,Utilization\n';
    navigator.clipboard.writeText(header + csv);
  };

  return (
    <div className="vlsm-designer">
      <h2 className="tool-title">VLSM Designer</h2>
      
      <div className="vlsm-inputs">
        <div className="input-group">
          <label htmlFor="parent-network-vlsm">Parent Network</label>
          <IpInput
            value={parentNetwork}
            onChange={setParentNetwork}
            error={error}
            placeholder="10.1.0.0/16"
          />
        </div>

        <div className="requirements-section">
          <h3>Requirements</h3>
          {requirements.map((req, i) => (
            <div key={i} className="requirement-row">
              <input
                type="text"
                value={req.name}
                onChange={(e) => updateRequirement(i, 'name', e.target.value)}
                placeholder="Name (e.g., Servers)"
                className="req-name-input"
              />
              <input
                type="number"
                value={req.hostsNeeded || ''}
                onChange={(e) => updateRequirement(i, 'hostsNeeded', parseInt(e.target.value, 10) || 0)}
                placeholder="Hosts needed"
                min="1"
                className="req-hosts-input"
              />
              {requirements.length > 1 && (
                <button
                  onClick={() => removeRequirement(i)}
                  className="btn-remove"
                  aria-label="Remove requirement"
                >
                  ×
                </button>
              )}
            </div>
          ))}
          <button onClick={addRequirement} className="btn-secondary">
            Add Requirement
          </button>
        </div>

        <button
          onClick={handleDesign}
          className="btn-primary"
          disabled={!parentNetwork.trim()}
        >
          Design VLSM
        </button>
      </div>

      {result && !result.error && (
        <div className="vlsm-results">
          <div className="results-header">
            <h3>Allocations</h3>
            <button onClick={handleExportCsv} className="btn-secondary">
              Export as CSV
            </button>
          </div>

          <table className="results-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Hosts Needed</th>
                <th>Subnet Allocated</th>
                <th>Actual Hosts</th>
                <th>Utilization</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {result.allocations.map((alloc, i) => (
                <tr key={i}>
                  <td>{alloc.name}</td>
                  <td>{alloc.hostsNeeded}</td>
                  <td className="monospace">{alloc.subnet}</td>
                  <td>{alloc.actualHosts}</td>
                  <td className={alloc.utilization < 50 ? 'low-util' : ''}>
                    {alloc.utilization.toFixed(1)}%
                  </td>
                  <td>
                    <CopyButton text={alloc.subnet} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {result.remainingSpace.length > 0 && (
            <div className="remaining-space">
              <h4>Remaining Unallocated Space</h4>
              {result.remainingSpace.map((space, i) => (
                <p key={i} className="monospace">{space}</p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Create SupernettingTool component**

Create `src/components/subnet/tools/SupernettingTool.tsx`:

```typescript
import { useState } from 'react';
import { supernet } from '../../../lib/subnetCalculations';
import { ResultCard } from '../shared/ResultCard';
import { CopyButton } from '../shared/CopyButton';

export function SupernettingTool() {
  const [subnetsText, setSubnetsText] = useState('');
  const [result, setResult] = useState<ReturnType<typeof supernet> | null>(null);

  const handleAggregate = () => {
    try {
      const subnets = subnetsText
        .split('\n')
        .map(s => s.trim())
        .filter(s => s.length > 0);
      
      if (subnets.length === 0) {
        return;
      }
      
      const aggregateResult = supernet(subnets);
      setResult(aggregateResult);
    } catch (err) {
      setResult({
        supernet: '',
        valid: false,
        error: err instanceof Error ? err.message : 'Invalid input',
      });
    }
  };

  return (
    <div className="supernetting-tool">
      <h2 className="tool-title">Supernetting</h2>
      
      <div className="supernet-inputs">
        <label htmlFor="subnets-textarea">Subnets (one per line)</label>
        <textarea
          id="subnets-textarea"
          value={subnetsText}
          onChange={(e) => setSubnetsText(e.target.value)}
          placeholder="192.168.0.0/24&#10;192.168.1.0/24&#10;192.168.2.0/24&#10;192.168.3.0/24"
          rows={10}
          className="subnets-textarea"
        />
        
        <button
          onClick={handleAggregate}
          className="btn-primary"
          disabled={!subnetsText.trim()}
        >
          Aggregate
        </button>
      </div>

      {result && (
        <ResultCard>
          {result.valid ? (
            <>
              <div className="supernet-success">
                <h3>Supernet</h3>
                <div className="supernet-value">
                  <span className="monospace large">{result.supernet}</span>
                  <CopyButton text={result.supernet} />
                </div>
                <p className="success-message">✓ All subnets are covered</p>
              </div>
            </>
          ) : (
            <div className="supernet-error">
              <h3>Cannot Aggregate</h3>
              <p className="error-message">✗ {result.error}</p>
              {result.supernet && (
                <p className="suggested-supernet">
                  Suggested supernet (may have gaps): <span className="monospace">{result.supernet}</span>
                </p>
              )}
            </div>
          )}
        </ResultCard>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create SubnetVisualizer component (simplified)**

Create `src/components/subnet/tools/SubnetVisualizer.tsx`:

```typescript
import { useState } from 'react';
import { parseCidr, calculateNetwork } from '../../../lib/subnetCalculations';

export function SubnetVisualizer() {
  const [network, setNetwork] = useState('');
  const [error, setError] = useState('');
  const [binary, setBinary] = useState<{ network: string; mask: string } | null>(null);

  const handleVisualize = () => {
    try {
      const { ip, prefix } = parseCidr(network);
      const info = calculateNetwork(ip, prefix);
      setBinary(info.binary);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Invalid input');
      setBinary(null);
    }
  };

  const formatBinary = (bin: string, prefix: number) => {
    const networkBits = bin.slice(0, prefix);
    const hostBits = bin.slice(prefix);
    return { networkBits, hostBits };
  };

  return (
    <div className="subnet-visualizer">
      <h2 className="tool-title">Subnet Visualizer</h2>
      
      <div className="visualizer-inputs">
        <input
          type="text"
          value={network}
          onChange={(e) => setNetwork(e.target.value)}
          placeholder="192.168.1.0/24"
          className="ip-input"
        />
        <button onClick={handleVisualize} className="btn-primary" disabled={!network.trim()}>
          Visualize
        </button>
      </div>

      {error && <p className="error-message">{error}</p>}

      {binary && (() => {
        const prefix = parseCidr(network).prefix;
        const { networkBits, hostBits } = formatBinary(binary.network, prefix);
        const { networkBits: maskNetworkBits, hostBits: maskHostBits } = formatBinary(binary.mask, prefix);

        return (
          <div className="bit-diagram">
            <h3>Bit Diagram</h3>
            
            <div className="binary-row">
              <span className="binary-label">Network Address:</span>
              <span className="binary-value">
                <span className="network-bits">{networkBits}</span>
                <span className="host-bits">{hostBits}</span>
              </span>
            </div>

            <div className="binary-row">
              <span className="binary-label">Subnet Mask:</span>
              <span className="binary-value">
                <span className="network-bits">{maskNetworkBits}</span>
                <span className="host-bits">{maskHostBits}</span>
              </span>
            </div>

            <div className="bit-legend">
              <div className="legend-item">
                <span className="network-bits sample">■</span> Network Bits (/{prefix})
              </div>
              <div className="legend-item">
                <span className="host-bits sample">■</span> Host Bits ({32 - prefix})
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
```

- [ ] **Step 4: Build to verify all tools compile**

Run: `npm run build:relaxed`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git add src/components/subnet/tools/VlsmDesigner.tsx src/components/subnet/tools/SupernettingTool.tsx src/components/subnet/tools/SubnetVisualizer.tsx
git commit -m "feat(subnet): add VLSM, Supernetting, and Visualizer tools

VlsmDesigner:
- Add/remove requirements dynamically
- Allocates largest-first with utilization %
- Shows remaining unallocated space
- CSV export

SupernettingTool:
- Paste multiple subnets (one per line)
- Validates contiguity and alignment
- Clear error messages

SubnetVisualizer:
- Bit diagram showing network/host boundary
- Color-coded network bits (blue) vs host bits (green)

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 13: Layout Components - FeatureSidebar and QuickReference

**Files:**
- Create: `src/components/subnet/FeatureSidebar.tsx`
- Create: `src/components/subnet/QuickReference.tsx`

**Interfaces:**
- Consumes: None
- Produces:
  - `FeatureSidebar({ activeFeature, onFeatureChange }: FeatureSidebarProps): JSX.Element`
  - `QuickReference({ isOpen, onToggle }: QuickReferenceProps): JSX.Element`

- [ ] **Step 1: Create FeatureSidebar component**

Create `src/components/subnet/FeatureSidebar.tsx`:

```typescript
export type FeatureType = 'cidr' | 'split' | 'vlsm' | 'super' | 'check' | 'visual';

export interface FeatureSidebarProps {
  activeFeature: FeatureType;
  onFeatureChange: (feature: FeatureType) => void;
}

export function FeatureSidebar({ activeFeature, onFeatureChange }: FeatureSidebarProps) {
  const features: { id: FeatureType; label: string; icon: string }[] = [
    { id: 'cidr', label: 'CIDR', icon: '🔢' },
    { id: 'split', label: 'Split', icon: '✂️' },
    { id: 'vlsm', label: 'VLSM', icon: '📊' },
    { id: 'super', label: 'Super', icon: '⬆️' },
    { id: 'check', label: 'Check', icon: '✓' },
    { id: 'visual', label: 'Visual', icon: '👁' },
  ];

  return (
    <div className="feature-sidebar">
      {features.map((feature) => (
        <button
          key={feature.id}
          onClick={() => onFeatureChange(feature.id)}
          className={`feature-button ${activeFeature === feature.id ? 'active' : ''}`}
          aria-label={`Switch to ${feature.label} tool`}
          aria-pressed={activeFeature === feature.id}
        >
          <span className="feature-icon">{feature.icon}</span>
          <span className="feature-label">{feature.label}</span>
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create QuickReference component**

Create `src/components/subnet/QuickReference.tsx`:

```typescript
export interface QuickReferenceProps {
  isOpen: boolean;
  onToggle: () => void;
}

export function QuickReference({ isOpen, onToggle }: QuickReferenceProps) {
  if (!isOpen) {
    return (
      <button onClick={onToggle} className="reference-toggle" aria-label="Show quick reference">
        ☰ Reference
      </button>
    );
  }

  return (
    <div className="quick-reference">
      <div className="reference-header">
        <h3>Quick Reference</h3>
        <button onClick={onToggle} className="reference-close" aria-label="Hide quick reference">
          ×
        </button>
      </div>

      <div className="reference-content">
        <section>
          <h4>RFC1918 Private Ranges</h4>
          <table className="reference-table">
            <tbody>
              <tr>
                <td className="monospace">10.0.0.0/8</td>
                <td>16,777,216 hosts</td>
              </tr>
              <tr>
                <td className="monospace">172.16.0.0/12</td>
                <td>1,048,576 hosts</td>
              </tr>
              <tr>
                <td className="monospace">192.168.0.0/16</td>
                <td>65,536 hosts</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section>
          <h4>Common Subnet Masks</h4>
          <table className="reference-table">
            <tbody>
              <tr>
                <td className="monospace">/24</td>
                <td className="monospace">255.255.255.0</td>
                <td>254 hosts</td>
              </tr>
              <tr>
                <td className="monospace">/25</td>
                <td className="monospace">255.255.255.128</td>
                <td>126 hosts</td>
              </tr>
              <tr>
                <td className="monospace">/26</td>
                <td className="monospace">255.255.255.192</td>
                <td>62 hosts</td>
              </tr>
              <tr>
                <td className="monospace">/27</td>
                <td className="monospace">255.255.255.224</td>
                <td>30 hosts</td>
              </tr>
              <tr>
                <td className="monospace">/28</td>
                <td className="monospace">255.255.255.240</td>
                <td>14 hosts</td>
              </tr>
              <tr>
                <td className="monospace">/29</td>
                <td className="monospace">255.255.255.248</td>
                <td>6 hosts</td>
              </tr>
              <tr>
                <td className="monospace">/30</td>
                <td className="monospace">255.255.255.252</td>
                <td>2 hosts</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Build to verify components compile**

Run: `npm run build:relaxed`
Expected: Build succeeds

- [ ] **Step 4: Commit**

```bash
git add src/components/subnet/FeatureSidebar.tsx src/components/subnet/QuickReference.tsx
git commit -m "feat(subnet): add FeatureSidebar and QuickReference

FeatureSidebar:
- 6 tool buttons (CIDR, Split, VLSM, Super, Check, Visual)
- Active state highlighting
- Icon + label for each tool

QuickReference:
- Collapsible right panel
- RFC1918 private ranges
- Common subnet masks (/24 through /30)
- Monospace tables for alignment

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 14: Main SubnetTab Component

**Files:**
- Create: `src/components/subnet/SubnetTab.tsx`
- Create: `src/components/subnet/SubnetTab.css`
- Create: `src/components/subnet/SubnetTab.test.tsx`

**Interfaces:**
- Consumes: All tool components, FeatureSidebar, QuickReference, Tab type
- Produces: `SubnetTab({ tab }: { tab: Tab }): JSX.Element` - main orchestrator

- [ ] **Step 1: Write failing test for SubnetTab**

Create `src/components/subnet/SubnetTab.test.tsx`:

```typescript
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubnetTab } from './SubnetTab';

describe('SubnetTab', () => {
  const mockTab = {
    id: 'test-subnet-tab',
    title: 'Subnet Calculator',
    type: 'subnet' as const,
  };

  it('renders without crashing', () => {
    render(<SubnetTab tab={mockTab} />);
    expect(screen.getByText(/Subnet Calculator/i)).toBeInTheDocument();
  });

  it('renders feature sidebar', () => {
    render(<SubnetTab tab={mockTab} />);
    expect(screen.getByText('CIDR')).toBeInTheDocument();
    expect(screen.getByText('Split')).toBeInTheDocument();
    expect(screen.getByText('VLSM')).toBeInTheDocument();
  });

  it('switches tools when sidebar button clicked', () => {
    render(<SubnetTab tab={mockTab} />);
    
    // Default tool is CIDR
    expect(screen.getByText('CIDR Calculator')).toBeInTheDocument();
    
    // Click Split button
    fireEvent.click(screen.getByText('Split'));
    
    // Should show Subnet Splitter
    expect(screen.getByText('Subnet Splitter')).toBeInTheDocument();
  });

  it('renders quick reference toggle', () => {
    render(<SubnetTab tab={mockTab} />);
    expect(screen.getByText(/Reference/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- SubnetTab.test.tsx`
Expected: FAIL (component not found)

- [ ] **Step 3: Create SubnetTab component**

Create `src/components/subnet/SubnetTab.tsx`:

```typescript
import { useState } from 'react';
import type { Tab } from '../../lib/types';
import { FeatureSidebar, type FeatureType } from './FeatureSidebar';
import { QuickReference } from './QuickReference';
import { CidrCalculator } from './tools/CidrCalculator';
import { SubnetSplitter } from './tools/SubnetSplitter';
import { VlsmDesigner } from './tools/VlsmDesigner';
import { SupernettingTool } from './tools/SupernettingTool';
import { IpChecker } from './tools/IpChecker';
import { SubnetVisualizer } from './tools/SubnetVisualizer';
import './SubnetTab.css';

export interface SubnetTabProps {
  tab: Tab;
}

export function SubnetTab({ tab }: SubnetTabProps) {
  const [activeFeature, setActiveFeature] = useState<FeatureType>('cidr');
  const [referenceOpen, setReferenceOpen] = useState(false);

  const renderActiveTool = () => {
    switch (activeFeature) {
      case 'cidr':
        return <CidrCalculator />;
      case 'split':
        return <SubnetSplitter />;
      case 'vlsm':
        return <VlsmDesigner />;
      case 'super':
        return <SupernettingTool />;
      case 'check':
        return <IpChecker />;
      case 'visual':
        return <SubnetVisualizer />;
      default:
        return <CidrCalculator />;
    }
  };

  return (
    <div className="subnet-tab">
      <FeatureSidebar
        activeFeature={activeFeature}
        onFeatureChange={setActiveFeature}
      />
      
      <div className="subnet-workspace">
        {renderActiveTool()}
      </div>

      <div className="subnet-reference-container">
        <QuickReference
          isOpen={referenceOpen}
          onToggle={() => setReferenceOpen(!referenceOpen)}
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Create SubnetTab CSS**

Create `src/components/subnet/SubnetTab.css`:

```css
.subnet-tab {
  display: flex;
  height: 100%;
  background: var(--bg-primary, #ffffff);
}

/* Feature Sidebar */
.feature-sidebar {
  width: 180px;
  padding: 16px;
  border-right: 1px solid var(--border-color, #e5e7eb);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.feature-button {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  transition: all 150ms;
  font-size: 14px;
}

.feature-button:hover {
  background: var(--hover-bg, #f3f4f6);
}

.feature-button.active {
  background: #3b82f6;
  color: white;
  border-color: #3b82f6;
}

.feature-icon {
  font-size: 20px;
}

.feature-label {
  font-weight: 500;
}

/* Main Workspace */
.subnet-workspace {
  flex: 1;
  padding: 24px;
  overflow-y: auto;
}

.tool-title {
  font-size: 24px;
  font-weight: 600;
  margin-bottom: 24px;
}

/* Quick Reference */
.subnet-reference-container {
  width: 240px;
  border-left: 1px solid var(--border-color, #e5e7eb);
}

.reference-toggle {
  position: absolute;
  top: 16px;
  right: 16px;
  padding: 8px 12px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 4px;
  background: white;
  cursor: pointer;
}

.quick-reference {
  padding: 16px;
  height: 100%;
  overflow-y: auto;
}

.reference-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.reference-close {
  border: none;
  background: none;
  font-size: 24px;
  cursor: pointer;
  padding: 0;
  width: 24px;
  height: 24px;
}

.reference-table {
  width: 100%;
  font-size: 12px;
  margin-bottom: 16px;
}

.reference-table td {
  padding: 4px 0;
}

/* Shared Styles */
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

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: white;
  color: #3b82f6;
  padding: 8px 16px;
  border-radius: 6px;
  border: 1px solid #3b82f6;
  cursor: pointer;
}

.btn-copy {
  background: transparent;
  border: 1px solid var(--border-color, #e5e7eb);
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 16px;
}

.monospace {
  font-family: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
}

.result-card {
  background: var(--card-bg, #f9fafb);
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 8px;
  padding: 20px;
  margin-top: 20px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.result-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: 1px solid var(--border-color, #e5e7eb);
}

.result-row:last-child {
  border-bottom: none;
}

.result-label {
  font-weight: 500;
  min-width: 150px;
}

.result-value {
  font-family: 'SF Mono', monospace;
  flex: 1;
}

.result-row.network .result-value {
  color: #3b82f6;
  font-weight: 600;
}

.result-row.broadcast .result-value {
  color: #f97316;
  font-weight: 600;
}

.result-row.usable .result-value {
  color: #10b981;
  font-weight: 600;
}

.ip-input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-color, #e5e7eb);
  border-radius: 6px;
  font-family: 'SF Mono', monospace;
}

.ip-input-error {
  border-color: #ef4444;
}

.ip-input-error-text {
  color: #dc2626;
  font-size: 14px;
  margin-top: 4px;
}

.empty-state {
  text-align: center;
  padding: 40px;
  color: var(--text-secondary, #6b7280);
}

.empty-state-example {
  font-family: 'SF Mono', monospace;
  font-size: 14px;
  margin-top: 8px;
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- SubnetTab.test.tsx`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/components/subnet/SubnetTab.tsx src/components/subnet/SubnetTab.css src/components/subnet/SubnetTab.test.tsx
git commit -m "feat(subnet): add main SubnetTab orchestrator

Three-column layout:
- Left: Feature sidebar (6 tools)
- Center: Active tool workspace
- Right: Quick reference (collapsible)

Tool switching via sidebar buttons
Fresh state on each tab open (no persistence)
Complete CSS with color-coded results

Tests verify tool switching

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 15: App Integration

**Files:**
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: `SubnetTab`, `tabNewSubnet`, `Tab` type with 'subnet'
- Produces: Subnet calculator tabs render in app, menu event listener wired

- [ ] **Step 1: Add subnet tab rendering to App.tsx**

Edit `src/App.tsx`, find the section where tabs are rendered (look for `tab.type === 'api'` or similar patterns). Add subnet tab rendering (likely using lazy loading pattern):

Near the top with other lazy imports (around line 18-25):

```typescript
const SubnetTab = lazy(() => import("./components/subnet/SubnetTab").then(m => ({ default: m.SubnetTab })));
```

In the tab content rendering section (look for where ApiTab, NetconfTab are rendered):

```typescript
{tab.type === 'subnet' && (
  <Suspense fallback={<div>Loading...</div>}>
    <SubnetTab tab={tab} />
  </Suspense>
)}
```

- [ ] **Step 2: Add menu event listener**

Find the section with `listen('menu:...` calls (around line 266+). Add after the other menu listeners:

```typescript
unlistens.push(listen('menu:subnet_new', async () => {
  const tab = await tabNewSubnet({ title: "Subnet Calculator" });
  addTab(tab);
}));
```

- [ ] **Step 3: Test in development mode**

Run: `npm run tauri dev`

Test:
1. File → New → Subnet Calculator (or ⌘⇧C)
2. Tab opens with CIDR Calculator visible
3. Click different tools in sidebar - should switch tools
4. Enter 192.168.1.0/24 in CIDR Calculator - should show results
5. Close tab - should close cleanly

Expected: All interactions work smoothly

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "feat(subnet): integrate SubnetTab into App

- Lazy load SubnetTab component
- Render subnet tabs in main tab switch
- Wire menu:subnet_new event listener
- Creates tab with title 'Subnet Calculator'

Subnet calculator now fully functional via File → New or ⌘⇧C

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Task 16: Run Full Test Suite

**Files:**
- N/A (verification task)

**Interfaces:**
- Consumes: All previous tasks
- Produces: Confidence that implementation meets spec requirements

- [ ] **Step 1: Run unit tests**

Run: `npm test`
Expected: All tests PASS, 80%+ overall coverage, 90%+ on subnetCalculations.ts

- [ ] **Step 2: Check test coverage**

Run: `npm test -- --coverage`
Expected:
- `src/lib/subnetCalculations.ts`: 90%+ coverage
- Overall: 80%+ coverage

- [ ] **Step 3: Run build**

Run: `npm run build`
Expected: Build succeeds with no errors

- [ ] **Step 4: Manual integration testing**

Run: `npm run tauri dev`

Test all six tools:

**CIDR Calculator:**
- [ ] Enter 192.168.1.0/24 → shows correct network info
- [ ] Enter 10.0.0.1 255.255.255.0 → parses dotted mask
- [ ] Enter invalid IP → shows error
- [ ] Copy buttons work
- [ ] Binary display toggles

**Subnet Splitter:**
- [ ] Split 192.168.1.0/24 into 4 → shows 4 /26 subnets
- [ ] Copy All as CSV works
- [ ] Invalid split (1000 subnets from /24) → shows error

**VLSM Designer:**
- [ ] Add 3 requirements → allocates subnets
- [ ] Remove requirement → updates allocations
- [ ] Requirements exceed capacity → shows error
- [ ] Export CSV works

**Supernetting:**
- [ ] Paste 4 contiguous /24s → aggregates to /22
- [ ] Non-contiguous subnets → shows error

**IP Checker:**
- [ ] IP in subnet → shows ✓ with position
- [ ] IP not in subnet → shows ✗

**Subnet Visualizer:**
- [ ] Enter network → shows bit diagram
- [ ] Network bits colored blue, host bits green

**General:**
- [ ] Tool switching works
- [ ] Quick Reference toggles
- [ ] Multiple tabs can be open
- [ ] Close tab works
- [ ] ⌘⇧C shortcut opens new tab

- [ ] **Step 5: Create final commit**

```bash
git add -A
git commit -m "test(subnet): verify all features and integration

Manual testing completed:
✓ All 6 tools functional
✓ Tool switching works smoothly
✓ Quick Reference panel toggles
✓ Keyboard shortcut (⌘⇧C) works
✓ Multiple tabs supported
✓ Copy buttons on all results
✓ Input validation with helpful errors
✓ Binary display collapsible
✓ CSV export works (Splitter, VLSM)

Test coverage: 80%+ overall, 90%+ on calculations

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"
```

---

## Self-Review Checklist

**1. Spec Coverage:**
- ✅ All 6 tools implemented (CIDR, Split, VLSM, Super, Check, Visual)
- ✅ Three-column layout (sidebar, workspace, reference panel)
- ✅ Menu integration (File → New → Subnet Calculator)
- ✅ Keyboard shortcut (⌘⇧C)
- ✅ Copy buttons on all results
- ✅ No persistence (fresh state)
- ✅ Client-side calculations only
- ✅ Color-coded results
- ✅ Input validation with errors
- ✅ Quick reference panel with RFC1918 + common masks
- ✅ Test coverage targets (80%+ overall, 90%+ calculations)

**2. Placeholder Scan:**
- ✅ No TBD, TODO, or "implement later"
- ✅ All code blocks complete
- ✅ All file paths exact
- ✅ All function signatures defined

**3. Type Consistency:**
- ✅ `FeatureType` used consistently in sidebar and SubnetTab
- ✅ `NetworkInfo` returned by calculations
- ✅ `VlsmRequirement`, `VlsmResult` types match across components
- ✅ `Tab` type includes 'subnet'

**4. Dependencies:**
- Task 2 → Task 3 (advanced functions use core functions)
- Task 3 → Task 4 (VLSM uses core functions)
- Task 5 → Task 6 (frontend wrappers need backend command)
- Tasks 2-4 → Tasks 8-12 (tools consume calculation library)
- Tasks 8-12 → Task 14 (SubnetTab uses all tools)
- Task 14 → Task 15 (App integrates SubnetTab)

All dependencies properly sequenced.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-24-subnet-calculator.md`.

**Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

Due to length constraints, I'll continue with the remaining tasks in the next message. The plan is shaping up well with proper TDD flow, detailed steps, and all the required components.