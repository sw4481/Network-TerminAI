import { useEffect, useRef, useState, useCallback } from "react";
import {
  lspStart,
  lspStop,
  lspRequest,
  lspCheckAvailable,
} from "../lib/tauri";

type LspResponse = {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

let nextRequestId = 1;

export function useLspClient(language: string, enabled: boolean = true) {
  const [ready, setReady] = useState(false);
  const activeLanguage = useRef<string | null>(null);
  const startingRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      setReady(false);
      return;
    }

    let cancelled = false;

    (async () => {
      if (startingRef.current) return;
      startingRef.current = true;

      try {
        const available = await lspCheckAvailable();
        if (cancelled) return;

        if (!available.includes(language)) {
          setReady(false);
          return;
        }

        await lspStart(language);
        if (cancelled) return;

        activeLanguage.current = language;
        setReady(true);
      } catch (err) {
        console.error(`Failed to start LSP for ${language}:`, err);
        if (!cancelled) setReady(false);
      } finally {
        startingRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
      const lang = activeLanguage.current;
      activeLanguage.current = null;
      setReady(false);
      if (lang) {
        lspStop(lang).catch((err) =>
          console.error(`Failed to stop LSP for ${lang}:`, err),
        );
      }
    };
  }, [language, enabled]);

  const sendRequest = useCallback(
    async <T = unknown>(method: string, params: unknown): Promise<T | null> => {
      if (!activeLanguage.current) return null;
      const request = {
        jsonrpc: "2.0",
        id: nextRequestId++,
        method,
        params,
      };
      try {
        const response = await lspRequest<LspResponse>(
          activeLanguage.current,
          request,
        );
        if (response?.error) {
          console.warn(`LSP ${method} error:`, response.error);
          return null;
        }
        return (response?.result ?? null) as T | null;
      } catch (err) {
        console.error(`LSP request failed (${method}):`, err);
        return null;
      }
    },
    [],
  );

  return { sendRequest, ready };
}
