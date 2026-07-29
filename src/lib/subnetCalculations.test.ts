import { describe, it, expect } from 'vitest';
import { ipToNumber, numberToIp, parseCidr, calculateNetwork, splitSubnet, checkIpInSubnet, supernet, designVlsm } from './subnetCalculations';
import type { VlsmRequirement } from './subnetCalculations';

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

  describe('standard subnets', () => {
    it('calculates /24 network correctly', () => {
      const result = calculateNetwork('192.168.1.0', 24);
      expect(result.network).toBe('192.168.1.0');
      expect(result.broadcast).toBe('192.168.1.255');
      expect(result.firstUsable).toBe('192.168.1.1');
      expect(result.lastUsable).toBe('192.168.1.254');
      expect(result.usableHosts).toBe(254);
      expect(result.subnetMask).toBe('255.255.255.0');
      expect(result.wildcardMask).toBe('0.0.0.255');
      expect(result.cidr).toBe(24);
    });

    it('calculates /16 network correctly', () => {
      const result = calculateNetwork('10.20.0.0', 16);
      expect(result.network).toBe('10.20.0.0');
      expect(result.broadcast).toBe('10.20.255.255');
      expect(result.firstUsable).toBe('10.20.0.1');
      expect(result.lastUsable).toBe('10.20.255.254');
      expect(result.usableHosts).toBe(65534);
      expect(result.subnetMask).toBe('255.255.0.0');
      expect(result.wildcardMask).toBe('0.0.255.255');
      expect(result.cidr).toBe(16);
    });

    it('calculates /8 network correctly', () => {
      const result = calculateNetwork('10.0.0.0', 8);
      expect(result.network).toBe('10.0.0.0');
      expect(result.broadcast).toBe('10.255.255.255');
      expect(result.firstUsable).toBe('10.0.0.1');
      expect(result.lastUsable).toBe('10.255.255.254');
      expect(result.usableHosts).toBe(16777214);
      expect(result.subnetMask).toBe('255.0.0.0');
      expect(result.wildcardMask).toBe('0.255.255.255');
      expect(result.cidr).toBe(8);
    });
  });

  describe('edge cases', () => {
    it('handles /0 (entire IPv4 space)', () => {
      const result = calculateNetwork('0.0.0.0', 0);
      expect(result.network).toBe('0.0.0.0');
      expect(result.broadcast).toBe('255.255.255.255');
      expect(result.firstUsable).toBe('0.0.0.1');
      expect(result.lastUsable).toBe('255.255.255.254');
      expect(result.usableHosts).toBe(4294967294);
      expect(result.subnetMask).toBe('0.0.0.0');
      expect(result.wildcardMask).toBe('255.255.255.255');
    });

    it('handles /31 (RFC 3021 point-to-point)', () => {
      const result = calculateNetwork('192.168.1.0', 31);
      expect(result.network).toBe('192.168.1.0');
      expect(result.broadcast).toBe('192.168.1.1');
      expect(result.firstUsable).toBe('192.168.1.0');
      expect(result.lastUsable).toBe('192.168.1.1');
      expect(result.usableHosts).toBe(2);
      expect(result.subnetMask).toBe('255.255.255.254');
      expect(result.wildcardMask).toBe('0.0.0.1');
    });

    it('handles /32 (single host)', () => {
      const result = calculateNetwork('192.168.1.5', 32);
      expect(result.network).toBe('192.168.1.5');
      expect(result.broadcast).toBe('192.168.1.5');
      expect(result.firstUsable).toBe('192.168.1.5');
      expect(result.lastUsable).toBe('192.168.1.5');
      expect(result.usableHosts).toBe(0);
      expect(result.subnetMask).toBe('255.255.255.255');
      expect(result.wildcardMask).toBe('0.0.0.0');
    });

    it('throws on invalid prefix < 0', () => {
      expect(() => calculateNetwork('192.168.1.0', -1)).toThrow('CIDR prefix must be between 0 and 32');
    });

    it('throws on invalid prefix > 32', () => {
      expect(() => calculateNetwork('192.168.1.0', 33)).toThrow('CIDR prefix must be between 0 and 32');
    });
  });

  describe('network address normalization', () => {
    it('normalizes 192.168.1.5/24 to network 192.168.1.0', () => {
      const result = calculateNetwork('192.168.1.5', 24);
      expect(result.network).toBe('192.168.1.0');
      expect(result.broadcast).toBe('192.168.1.255');
    });

    it('normalizes 10.20.30.40/16 to network 10.20.0.0', () => {
      const result = calculateNetwork('10.20.30.40', 16);
      expect(result.network).toBe('10.20.0.0');
      expect(result.broadcast).toBe('10.20.255.255');
    });

    it('normalizes 172.16.99.199/12 to network 172.16.0.0', () => {
      const result = calculateNetwork('172.16.99.199', 12);
      expect(result.network).toBe('172.16.0.0');
      expect(result.broadcast).toBe('172.31.255.255');
    });
  });

  describe('binary output correctness', () => {
    it('produces correct binary for /24 network', () => {
      const result = calculateNetwork('192.168.1.0', 24);
      // 192.168.1.0 = 11000000.10101000.00000001.00000000
      expect(result.binary.network).toBe('11000000101010000000000100000000');
      // 255.255.255.0 = 11111111.11111111.11111111.00000000
      expect(result.binary.mask).toBe('11111111111111111111111100000000');
    });

    it('produces correct binary for /16 network', () => {
      const result = calculateNetwork('10.20.0.0', 16);
      // 10.20.0.0 = 00001010.00010100.00000000.00000000
      expect(result.binary.network).toBe('00001010000101000000000000000000');
      // 255.255.0.0 = 11111111.11111111.00000000.00000000
      expect(result.binary.mask).toBe('11111111111111110000000000000000');
    });

    it('produces correct binary for /32 host', () => {
      const result = calculateNetwork('192.168.1.1', 32);
      // 192.168.1.1 = 11000000.10101000.00000001.00000001
      expect(result.binary.network).toBe('11000000101010000000000100000001');
      // 255.255.255.255 = 11111111.11111111.11111111.11111111
      expect(result.binary.mask).toBe('11111111111111111111111111111111');
    });

    it('produces correct binary for /0 network', () => {
      const result = calculateNetwork('0.0.0.0', 0);
      // 0.0.0.0 = 00000000.00000000.00000000.00000000
      expect(result.binary.network).toBe('00000000000000000000000000000000');
      // 0.0.0.0 mask = 00000000.00000000.00000000.00000000
      expect(result.binary.mask).toBe('00000000000000000000000000000000');
    });
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
