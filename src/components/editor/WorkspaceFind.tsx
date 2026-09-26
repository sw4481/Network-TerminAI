import { useState, type FormEvent } from "react";
import { editorFindInFiles, type EditorSearchMatch } from "../../lib/tauri";
import "./WorkspaceFind.css";

type WorkspaceFindProps = {
  rootPath: string | null;
  onClose: () => void;
  onOpenResult: (
    filePath: string,
    position: { line: number; column: number },
  ) => Promise<boolean> | boolean;
};

export function WorkspaceFind({
  rootPath,
  onClose,
  onOpenResult,
}: WorkspaceFindProps) {
  const [query, setQuery] = useState("");
  const [filePattern, setFilePattern] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [results, setResults] = useState<EditorSearchMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!rootPath) return;
    setSearching(true);
    setError(null);
    setResults([]);
    try {
      setResults(
        await editorFindInFiles({
          workspaceRoot: rootPath,
          query,
          regex,
          matchCase,
          wholeWord: regex ? false : wholeWord,
          filePattern: filePattern.trim() || null,
          maxResults: 5000,
        }),
      );
    } catch (searchError) {
      setError(String(searchError));
    } finally {
      setSearching(false);
    }
  };

  const openResult = (result: EditorSearchMatch) => {
    void Promise.resolve(
      onOpenResult(result.file_path, {
        line: result.line,
        column: result.column,
      }),
    ).catch((openError) => setError(String(openError)));
  };

  return (
    <section
      className="workspace-find"
      role="dialog"
      aria-label="Workspace search"
    >
      <div className="workspace-find-header">
        <span>Workspace Search</span>
        <button type="button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <form onSubmit={(event) => void submit(event)}>
        <div className="workspace-find-fields">
          <label>
            Search
            <input
              aria-label="Search query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label>
            Files
            <input
              aria-label="File pattern"
              placeholder="*.ts,router.cfg"
              value={filePattern}
              onChange={(event) => setFilePattern(event.target.value)}
            />
          </label>
          <button type="submit" disabled={!rootPath || searching}>
            {searching ? "Searching…" : "Search"}
          </button>
        </div>

        <div className="workspace-find-options">
          <label>
            <input
              type="checkbox"
              checked={matchCase}
              onChange={(event) => setMatchCase(event.target.checked)}
            />
            Match case
          </label>
          <label>
            <input
              type="checkbox"
              checked={wholeWord}
              disabled={regex}
              onChange={(event) => setWholeWord(event.target.checked)}
            />
            Whole word
          </label>
          <label>
            <input
              type="checkbox"
              checked={regex}
              onChange={(event) => setRegex(event.target.checked)}
            />
            Regular expression
          </label>
        </div>
      </form>

      {!rootPath && (
        <p className="workspace-find-status">
          Select a workspace folder before searching.
        </p>
      )}
      {regex && (
        <p className="workspace-find-status">
          Whole word is unavailable with regular expressions.
        </p>
      )}
      {error && (
        <p className="workspace-find-error" role="alert">
          {error}
        </p>
      )}

      <div className="workspace-find-results">
        {results.map((result) => (
          <button
            type="button"
            key={`${result.file_path}:${result.line}:${result.column}`}
            onClick={() => openResult(result)}
          >
            <span className="workspace-find-location">
              {result.file_path} · {result.line}:{result.column}
            </span>
            <span className="workspace-find-preview">{result.preview}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
