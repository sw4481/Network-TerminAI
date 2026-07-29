import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  normalizeLspLanguage,
  useLspClient,
} from "../../../hooks/useLspClient";
import type { LspRange } from "./NavigationProviders";
import {
  fileUriToPath,
  pathIsWithinWorkspace,
} from "./locationRouting";
import "./WorkspaceSymbolSearch.css";

type LspWorkspaceSymbol = {
  name?: unknown;
  kind?: unknown;
  containerName?: unknown;
  location?: {
    uri?: unknown;
    range?: unknown;
  };
};

export type WorkspaceSymbolResult = {
  name: string;
  kind: number;
  kindLabel: string;
  containerName: string | null;
  uri: string;
  filePath: string;
  displayPath: string;
  range: LspRange;
};

const SYMBOL_KINDS = [
  "",
  "File",
  "Module",
  "Namespace",
  "Package",
  "Class",
  "Method",
  "Property",
  "Field",
  "Constructor",
  "Enum",
  "Interface",
  "Function",
  "Variable",
  "Constant",
  "String",
  "Number",
  "Boolean",
  "Array",
  "Object",
  "Key",
  "Null",
  "Enum member",
  "Struct",
  "Event",
  "Operator",
  "Type parameter",
];

function isRange(value: unknown): value is LspRange {
  if (!value || typeof value !== "object") return false;
  const range = value as LspRange;
  return (
    typeof range.start?.line === "number" &&
    typeof range.start.character === "number" &&
    typeof range.end?.line === "number" &&
    typeof range.end.character === "number"
  );
}

function relativePath(filePath: string, workspaceRoot: string): string {
  const root = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  return filePath === root
    ? filePath.split("/").pop() ?? filePath
    : filePath.slice(root.length + 1);
}

export function normalizeWorkspaceSymbols(
  value: unknown,
  workspaceRoot: string,
): WorkspaceSymbolResult[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): WorkspaceSymbolResult[] => {
    const symbol = item as LspWorkspaceSymbol;
    const name = typeof symbol.name === "string" ? symbol.name.trim() : "";
    const uri =
      typeof symbol.location?.uri === "string" ? symbol.location.uri : "";
    const filePath = fileUriToPath(uri);
    if (
      !name ||
      !filePath ||
      !pathIsWithinWorkspace(filePath, workspaceRoot) ||
      !isRange(symbol.location?.range)
    ) {
      return [];
    }
    const kind =
      typeof symbol.kind === "number" && Number.isInteger(symbol.kind)
        ? symbol.kind
        : 0;
    return [
      {
        name,
        kind,
        kindLabel: SYMBOL_KINDS[kind] ?? "Symbol",
        containerName:
          typeof symbol.containerName === "string" &&
          symbol.containerName.trim()
            ? symbol.containerName
            : null,
        uri,
        filePath,
        displayPath: relativePath(filePath, workspaceRoot),
        range: symbol.location.range,
      },
    ];
  });
}

export function WorkspaceSymbolSearch({
  open,
  language,
  workspaceRoot,
  onClose,
  onSelect,
}: {
  open: boolean;
  language: string;
  workspaceRoot: string | null;
  onClose: () => void;
  onSelect: (symbol: WorkspaceSymbolResult) => void | Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [symbols, setSymbols] = useState<WorkspaceSymbolResult[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const generation = useRef(0);
  const supportedLanguage = normalizeLspLanguage(language);
  const lsp = useLspClient(language, workspaceRoot, open);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSymbols([]);
      setSelectedIndex(0);
      setError(null);
      return;
    }
    queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open || !lsp.ready || !workspaceRoot) return;
    const currentGeneration = ++generation.current;
    setSearching(true);
    setError(null);
    const timer = setTimeout(() => {
      void lsp
        .sendRequest<unknown>("workspace/symbol", { query })
        .then((result) => {
          if (generation.current !== currentGeneration) return;
          setSymbols(normalizeWorkspaceSymbols(result, workspaceRoot).slice(0, 100));
          setSelectedIndex(0);
        })
        .catch((searchError) => {
          if (generation.current === currentGeneration) {
            setError(String(searchError));
            setSymbols([]);
          }
        })
        .finally(() => {
          if (generation.current === currentGeneration) setSearching(false);
        });
    }, 160);
    return () => clearTimeout(timer);
  }, [open, lsp.ready, lsp.sendRequest, query, workspaceRoot]);

  const status = useMemo(() => {
    if (error) return error;
    if (!supportedLanguage) {
      return `No project language server for ${language}`;
    }
    if (lsp.error) return lsp.error;
    if (!lsp.ready) return "Starting language server…";
    if (searching) return "Searching project symbols…";
    if (symbols.length === 0) return "No matching project symbols";
    return `${symbols.length} project symbol${symbols.length === 1 ? "" : "s"}`;
  }, [
    error,
    language,
    lsp.error,
    lsp.ready,
    searching,
    supportedLanguage,
    symbols.length,
  ]);

  if (!open) return null;

  const choose = (symbol: WorkspaceSymbolResult | undefined) => {
    if (!symbol) return;
    void Promise.resolve(onSelect(symbol))
      .then(onClose)
      .catch((selectError) => setError(String(selectError)));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((index) =>
        symbols.length === 0 ? 0 : (index + 1) % symbols.length,
      );
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((index) =>
        symbols.length === 0
          ? 0
          : (index - 1 + symbols.length) % symbols.length,
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(symbols[selectedIndex]);
    }
  };

  return (
    <div
      className="workspace-symbol-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="workspace-symbol-search"
        role="dialog"
        aria-modal="true"
        aria-label="Go to symbol in project"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Go to symbol in project…"
          aria-label="Project symbol query"
        />
        <div className="workspace-symbol-status" aria-live="polite">
          {status}
          {lsp.serverName ? ` · ${lsp.serverName}` : ""}
        </div>
        <div className="workspace-symbol-results" role="listbox">
          {symbols.map((symbol, index) => (
            <button
              type="button"
              role="option"
              aria-selected={index === selectedIndex}
              className={
                index === selectedIndex ? "workspace-symbol--selected" : ""
              }
              key={`${symbol.uri}:${symbol.range.start.line}:${symbol.name}`}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => choose(symbol)}
            >
              <span className="workspace-symbol-kind">{symbol.kindLabel}</span>
              <span className="workspace-symbol-name">{symbol.name}</span>
              {symbol.containerName && (
                <span className="workspace-symbol-container">
                  {symbol.containerName}
                </span>
              )}
              <span className="workspace-symbol-path">
                {symbol.displayPath}:{symbol.range.start.line + 1}
              </span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
