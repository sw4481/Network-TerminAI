import { useEffect, useState, useCallback } from "react";
import { getStructured, type ParsedOutput } from "../lib/structured";

export interface UseStructuredOutputState {
  loading: boolean;
  parsed: ParsedOutput | null;
  error: string | null;
  refresh: () => void;
}

export function useStructuredOutput(blockId: string | null): UseStructuredOutputState {
  const [loading, setLoading] = useState(false);
  const [parsed, setParsed] = useState<ParsedOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  useEffect(() => {
    if (!blockId) {
      setParsed(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    getStructured(blockId)
      .then((p) => {
        if (!cancelled) {
          setParsed(p);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [blockId, tick]);

  return { loading, parsed, error, refresh };
}
