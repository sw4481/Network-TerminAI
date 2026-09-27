import { useCallback, useEffect, useRef, useState } from "react";
import {
  gitGetRepositorySummary,
  type GitRepositorySummary,
} from "../../lib/tauri";

export type GitRepositorySummaryLoader = (
  path: string,
) => Promise<GitRepositorySummary | null>;

export function useGitRepositorySummary(
  path: string | null,
  enabled: boolean,
  loader: GitRepositorySummaryLoader = gitGetRepositorySummary,
) {
  const [summary, setSummary] = useState<GitRepositorySummary | null>(null);
  const generationRef = useRef(0);

  const refresh = useCallback(async () => {
    const generation = ++generationRef.current;
    if (!enabled || !path) {
      setSummary(null);
      return null;
    }
    try {
      const next = await loader(path);
      if (generation === generationRef.current) setSummary(next);
      return next;
    } catch {
      if (generation === generationRef.current) setSummary(null);
      return null;
    }
  }, [enabled, loader, path]);

  useEffect(() => {
    if (!enabled || !path) {
      generationRef.current += 1;
      setSummary(null);
      return;
    }

    setSummary(null);
    void refresh();
    const interval = window.setInterval(() => void refresh(), 10_000);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      generationRef.current += 1;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, [enabled, path, refresh]);

  return { summary, refresh };
}
