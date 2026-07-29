import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePcapSummary } from './usePcapSummary';

vi.mock('../lib/pcap', () => ({
  summarize: vi.fn(),
}));

import { summarize } from '../lib/pcap';

describe('usePcapSummary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not call summarize when captureId is null', () => {
    renderHook(() => usePcapSummary(null, null));
    expect(summarize).not.toHaveBeenCalled();
  });

  it('passes displayFilter through to summarize and re-invokes when it changes', async () => {
    const calls: Array<string | null> = [];
    (summarize as ReturnType<typeof vi.fn>).mockImplementation(
      async (_id: string, opts?: { displayFilter?: string | null }) => {
        calls.push(opts?.displayFilter ?? null);
        return { packet_count: 0, packets: [] };
      },
    );
    const { rerender, result } = renderHook(
      ({ filter }) => usePcapSummary('cap-1', filter),
      { initialProps: { filter: null as string | null } },
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    rerender({ filter: 'tcp.port==443' });
    await waitFor(() => expect(calls.length).toBe(2));
    expect(calls).toEqual([null, 'tcp.port==443']);
  });

  it('flips invalidFilter when summarize rejects with invalid_filter', async () => {
    (summarize as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('invalid_filter: bad expression'),
    );
    const { result } = renderHook(() => usePcapSummary('cap-1', 'bad'));
    await waitFor(() => expect(result.current.invalidFilter).toBe(true));
    expect(result.current.error).toContain('invalid_filter');
  });
});
