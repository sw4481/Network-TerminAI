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

  // Handle /0 special case (JavaScript shift limitation)
  const maskNum = prefix === 0 ? 0 : (0xFFFFFFFF << (32 - prefix)) >>> 0;
  const wildcardNum = prefix === 0 ? 0xFFFFFFFF : (~maskNum) >>> 0;

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

  // Calculate the range we need to cover
  const rangeSize = lastNum - firstNum + 1;
  const bitsNeeded = Math.ceil(Math.log2(rangeSize));
  let superPrefix = 32 - bitsNeeded;

  // Find the network boundary that aligns with this prefix
  const maskNum = (0xFFFFFFFF << (32 - superPrefix)) >>> 0;
  let superNetNum = (firstNum & maskNum) >>> 0;

  // Make sure the supernet actually covers the last IP
  let superBroadcastNum = (superNetNum | (~maskNum >>> 0)) >>> 0;
  while (superBroadcastNum < lastNum && superPrefix > 0) {
    superPrefix--;
    const newMaskNum = (0xFFFFFFFF << (32 - superPrefix)) >>> 0;
    superNetNum = (firstNum & newMaskNum) >>> 0;
    superBroadcastNum = (superNetNum | (~newMaskNum >>> 0)) >>> 0;
  }

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

  // Check total requirements
  const totalNeeded = requirements.reduce((sum, r) => sum + r.hostsNeeded, 0);
  if (totalNeeded > parentInfo.usableHosts) {
    return {
      allocations: [],
      remainingSpace: [],
      error: `Requirements exceed capacity (need ${totalNeeded}, have ${parentInfo.usableHosts})`,
    };
  }

  // Sort requirements by size (largest first)
  const sorted = [...requirements].sort((a, b) => b.hostsNeeded - a.hostsNeeded);

  const allocations: VlsmAllocation[] = [];
  let currentNum = parentNum;
  const parentEndNum = ipToNumber(parentInfo.broadcast);

  for (const req of sorted) {
    // Find smallest prefix that fits hostsNeeded
    // Search from /32 down to /0 and take the first match (tightest fit)
    let bestPrefix = -1;
    for (let p = 32; p >= 0; p--) {
      const testInfo = calculateNetwork(numberToIp(currentNum), p);
      if (testInfo.usableHosts >= req.hostsNeeded) {
        bestPrefix = p;
        break; // First match is the smallest subnet that fits
      }
    }

    if (bestPrefix < 0) {
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
