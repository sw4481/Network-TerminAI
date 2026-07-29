import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { PcapPacketList } from './PcapPacketList';
import type { PcapPacket } from '../lib/pcap';

const fixtures: PcapPacket[] = [
  {
    no: 1,
    time: 1700000000.123456,
    src: '10.0.0.1',
    dst: '10.0.0.2',
    protocol: 'ICMP',
    length: 98,
  },
  {
    no: 2,
    time: 1700000000.223456,
    src: '10.0.0.2',
    dst: '10.0.0.1',
    protocol: 'ICMP',
    length: 98,
  },
  {
    no: 3,
    time: 1700000001.123456,
    src: '10.0.0.1',
    dst: '8.8.8.8',
    protocol: 'DNS',
    length: 78,
  },
];

describe('PcapPacketList', () => {
  it('renders a sticky filter bar and the count summary', () => {
    render(
      <PcapPacketList
        packets={fixtures}
        totalCount={fixtures.length}
        displayFilter=""
        onSelectPacket={() => {}}
        selectedPacketNo={null}
        onDisplayFilterChange={() => {}}
      />,
    );
    expect(screen.getByTestId('pcap-filter-input')).toBeInTheDocument();
    expect(screen.getByTestId('pcap-filter-summary').textContent).toContain('3');
  });

  it('renders a row for every packet (non-virtualized)', () => {
    // The list is no longer virtualized — the summarizer caps results so a
    // plain table renders every row and scrolls reliably. Assert all rows
    // render (the virtualized version rendered only a partial set in jsdom).
    const { container } = render(
      <PcapPacketList
        packets={fixtures}
        totalCount={fixtures.length}
        displayFilter=""
        onSelectPacket={() => {}}
        selectedPacketNo={null}
        onDisplayFilterChange={() => {}}
      />,
    );
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(fixtures.length);
  });

  it('debounces filter input changes (300ms) before invoking onDisplayFilterChange', async () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    render(
      <PcapPacketList
        packets={fixtures}
        totalCount={fixtures.length}
        displayFilter=""
        onSelectPacket={() => {}}
        selectedPacketNo={null}
        onDisplayFilterChange={onChange}
      />,
    );
    const input = screen.getByTestId('pcap-filter-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'icmp' } });
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(310);
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith('icmp');
    vi.useRealTimers();
  });

  it('renders an invalid-filter outline when invalidFilter is true', () => {
    render(
      <PcapPacketList
        packets={fixtures}
        totalCount={fixtures.length}
        displayFilter="bad"
        invalidFilter
        onSelectPacket={() => {}}
        selectedPacketNo={null}
        onDisplayFilterChange={() => {}}
      />,
    );
    const input = screen.getByTestId('pcap-filter-input');
    expect(input.className).toContain('invalid');
  });
});
