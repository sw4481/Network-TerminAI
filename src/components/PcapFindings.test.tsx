import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PCAP_FINDINGS_RULES_STORAGE_KEY, PcapFindings } from './PcapFindings';

const mocks = vi.hoisted(() => ({
  rules: vi.fn(),
  findings: vi.fn(),
}));

vi.mock('../lib/pcap', () => ({
  findingRules: mocks.rules,
  findings: mocks.findings,
}));

const rules = [
  {
    rule_id: 'bgp.notification',
    category: 'BGP',
    severity: 'critical',
    title: 'BGP NOTIFICATION',
    display_filter: 'bgp.type == 3',
    enabled_by_default: true,
  },
  {
    rule_id: 'http.client_error',
    category: 'HTTP',
    severity: 'low',
    title: 'HTTP 4xx response',
    display_filter: 'http.response.code >= 400 && http.response.code <= 499',
    enabled_by_default: true,
  },
] as const;

describe('PcapFindings', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.rules.mockReset().mockResolvedValue(rules);
    mocks.findings.mockReset().mockResolvedValue({
      findings: [{
        ...rules[0],
        count: 1,
        evidence: [{
          no: 7,
          time: 1,
          src: '192.0.2.1',
          dst: '198.51.100.2',
          protocol: 'BGP',
          length: 64,
        }],
        evidence_truncated: false,
      }],
      scanned_packets: 42,
      scan_limit: 250_000,
      scan_truncated: false,
    });
  });

  it('enables fixed rules by default and renders deterministic evidence on demand', async () => {
    render(<PcapFindings captureId="capture-1" />);
    expect(await screen.findByText('BGP NOTIFICATION')).toBeInTheDocument();
    expect(screen.getByText('HTTP 4xx response')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pcap-findings-run'));

    await waitFor(() => expect(mocks.findings).toHaveBeenCalledWith(
      'capture-1',
      ['bgp.notification', 'http.client_error'],
    ));
    expect(await screen.findByText('192.0.2.1')).toBeInTheDocument();
    expect(screen.getByText('bgp.type == 3')).toBeInTheDocument();
  });

  it('persists only enabled IDs under the versioned local-storage key', async () => {
    render(<PcapFindings captureId="capture-1" />);
    const http = await screen.findByText('HTTP 4xx response');
    fireEvent.click(http.closest('label')!.querySelector('input')!);
    expect(JSON.parse(localStorage.getItem(PCAP_FINDINGS_RULES_STORAGE_KEY)!)).toEqual([
      'bgp.notification',
    ]);
    expect(screen.getByTestId('pcap-findings-run')).toHaveTextContent('Run findings (1)');
  });

  it('surfaces unsupported built-in filter errors without an editor', async () => {
    mocks.findings.mockRejectedValue(new Error('unsupported_filter: unknown field'));
    render(<PcapFindings captureId="capture-1" />);
    await screen.findByText('BGP NOTIFICATION');
    fireEvent.click(screen.getByTestId('pcap-findings-run'));
    expect(await screen.findByTestId('pcap-findings-error')).toHaveTextContent(
      'Installed TShark does not support one of the built-in filters',
    );
  });
});
