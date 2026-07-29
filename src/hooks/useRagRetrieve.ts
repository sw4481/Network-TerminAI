import { useCallback, useState } from "react";
import {
  ragRetrieve,
  type RagTag,
  type RetrievedChunk,
} from "../lib/rag";

/**
 * Plan 12 Phase 4 — thin React wrapper around `ragRetrieve`.
 *
 * Components that want to call the backend retrieval synchronously
 * (e.g. an inline "search the knowledge base" affordance) get the same
 * `loading / results / error` shape as `usePcapSummary` without
 * re-implementing the cancellation dance every time.
 *
 * The hook does NOT auto-fetch — callers invoke `retrieve` explicitly.
 * Phase 5 will plumb a higher-level "retrieve before sending agent
 * message" hook that owns its own lifecycle.
 */
export interface UseRagRetrieveState {
  retrieve: (args: { query: string; tags: RagTag[]; k: number }) => Promise<RetrievedChunk[]>;
  results: RetrievedChunk[];
  loading: boolean;
  error: string | null;
}

export function useRagRetrieve(): UseRagRetrieveState {
  const [results, setResults] = useState<RetrievedChunk[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const retrieve = useCallback(
    async (args: { query: string; tags: RagTag[]; k: number }) => {
      setLoading(true);
      setError(null);
      try {
        const out = await ragRetrieve(args);
        setResults(out);
        return out;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setError(msg);
        // Don't clobber previous results on transient error — caller
        // can decide whether to show stale data alongside the error.
        throw e;
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  return { retrieve, results, loading, error };
}
