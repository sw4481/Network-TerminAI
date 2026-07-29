import { useCallback, useEffect, useRef, useState } from "react";
import {
  lspStart,
  lspStop,
  lspRequest,
  lspCheckAvailable,
  lspDocumentOpen,
  lspDocumentChange,
  lspDocumentClose,
  type LspSessionInfo,
} from "../lib/tauri";

type ActiveLspSession = {
  language: "python" | "yaml";
  workspaceRoot: string;
  clientId: string;
};

export type LspClient = {
  clientId: string;
  ready: boolean;
  serverName: string | null;
  error: string | null;
  sendRequest: <T = unknown>(method: string, params: unknown) => Promise<T | null>;
  openDocument: (
    uri: string,
    languageId: string,
    text: string,
  ) => Promise<void>;
  changeDocument: (uri: string, text: string) => Promise<void>;
  closeDocument: (uri: string) => Promise<void>;
};

export function normalizeLspLanguage(
  language: string,
): ActiveLspSession["language"] | null {
  switch (language.trim().toLowerCase()) {
    case "python":
      return "python";
    case "yaml":
    case "yml":
      return "yaml";
    default:
      return null;
  }
}

function newClientId(): string {
  return `lsp:${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

export function useLspClient(
  language: string,
  workspaceRoot: string | null | undefined,
  enabled: boolean = true,
): LspClient {
  const [ready, setReady] = useState(false);
  const [serverName, setServerName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState(newClientId);
  const activeSession = useRef<ActiveLspSession | null>(null);
  const normalizedLanguage = normalizeLspLanguage(language);
  const normalizedRoot = workspaceRoot?.trim() || null;

  useEffect(() => {
    activeSession.current = null;
    setReady(false);
    setServerName(null);
    setError(null);

    if (!enabled || !normalizedLanguage || !normalizedRoot) {
      return;
    }

    const session: ActiveLspSession = {
      language: normalizedLanguage,
      workspaceRoot: normalizedRoot,
      clientId: newClientId(),
    };
    setClientId(session.clientId);
    let cancelled = false;
    let acquired = false;
    let released = false;

    const release = () => {
      if (!acquired || released) return;
      released = true;
      void lspStop(
        session.language,
        session.workspaceRoot,
        session.clientId,
      ).catch((stopError) => {
        console.error(
          `Failed to stop LSP for ${session.language}:`,
          stopError,
        );
      });
    };

    void (async () => {
      try {
        const available = await lspCheckAvailable(session.workspaceRoot);
        if (cancelled) return;
        if (!available.includes(session.language)) {
          setError(
            session.language === "python"
              ? "Pyright is unavailable"
              : "YAML language server is unavailable",
          );
          return;
        }

        const info: LspSessionInfo = await lspStart(
          session.language,
          session.workspaceRoot,
          session.clientId,
        );
        acquired = true;
        if (cancelled) {
          release();
          return;
        }
        activeSession.current = session;
        setServerName(info.serverName);
        setReady(true);
      } catch (startError) {
        console.error(`Failed to start LSP for ${session.language}:`, startError);
        if (!cancelled) {
          setError(String(startError));
          setReady(false);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (
        activeSession.current?.language === session.language &&
        activeSession.current.workspaceRoot === session.workspaceRoot
      ) {
        activeSession.current = null;
      }
      setReady(false);
      release();
    };
  }, [enabled, normalizedLanguage, normalizedRoot]);

  const requireSession = useCallback(() => {
    const session = activeSession.current;
    if (!session) {
      throw new Error("LSP session is not ready");
    }
    return session;
  }, []);

  const sendRequest = useCallback(
    async <T = unknown>(method: string, params: unknown): Promise<T | null> => {
      const session = activeSession.current;
      if (!session) return null;
      try {
        return await lspRequest<T>(
          session.language,
          session.workspaceRoot,
          method,
          params,
        );
      } catch (requestError) {
        console.error(`LSP request failed (${method}):`, requestError);
        setError(String(requestError));
        return null;
      }
    },
    [],
  );

  const openDocument = useCallback(
    async (uri: string, languageId: string, text: string) => {
      const session = requireSession();
      await lspDocumentOpen(
        session.language,
        session.workspaceRoot,
        session.clientId,
        uri,
        languageId,
        text,
      );
    },
    [requireSession],
  );

  const changeDocument = useCallback(
    async (uri: string, text: string) => {
      const session = requireSession();
      await lspDocumentChange(
        session.language,
        session.workspaceRoot,
        session.clientId,
        uri,
        text,
      );
    },
    [requireSession],
  );

  const closeDocument = useCallback(
    async (uri: string) => {
      const session = requireSession();
      await lspDocumentClose(
        session.language,
        session.workspaceRoot,
        session.clientId,
        uri,
      );
    },
    [requireSession],
  );

  return {
    clientId,
    ready,
    serverName,
    error,
    sendRequest,
    openDocument,
    changeDocument,
    closeDocument,
  };
}
