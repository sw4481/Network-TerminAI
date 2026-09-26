import { useEffect, useState } from 'react';
import { summarize, type PcapSummary } from '../lib/pcap';

export interface UsePcapSummaryState {
  loading: boolean;
  summary: PcapSummary | null;
  error: string | null;
  invalidFilter: boolean;
}

/**
 * Fetch (and re-fetch when `displayFilter` changes) the structured summary
 * for a captured pcap. The hook surfaces `invalidFilter` separately so the
 * filter input can render a red outline without ditching the prior summary.
 */
export function usePcapSummary(
  captureId: string | null,
  displayFilter: string | null,
  maxPackets = 200,
): UsePcapSummaryState {
  const [state, setState] = useState<UsePcapSummaryState>({
    loading: false,
    summary: null,
    error: null,
    invalidFilter: false,
  });

  useEffect(() => {
    if (!captureId) {
      setState({ loading: false, summary: null, error: null, invalidFilter: false });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: null, invalidFilter: false }));
    summarize(captureId, { maxPackets, displayFilter: displayFilter || null })
      .then((summary) => {
        if (cancelled) return;
        setState({ loading: false, summary, error: null, invalidFilter: false });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = String(err);
        const invalid = msg.includes('invalid_filter');
        setState((s) => ({
          loading: false,
          summary: invalid ? s.summary : null,
          error: msg,
          invalidFilter: invalid,
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [captureId, displayFilter, maxPackets]);

  return state;
}
