import { useEffect, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import "./FindReplace.css";

type FindReplaceProps = {
  editor: Monaco.editor.IStandaloneCodeEditor | null;
  onClose: () => void;
};

type Options = {
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
};

export function FindReplace({ editor, onClose }: FindReplaceProps) {
  const [findText, setFindText] = useState("");
  const [replaceText, setReplaceText] = useState("");
  const [options, setOptions] = useState<Options>({
    matchCase: false,
    wholeWord: false,
    regex: false,
  });
  const [matchCount, setMatchCount] = useState(0);
  const [currentMatch, setCurrentMatch] = useState(0);
  const findInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, []);

  const findAllMatches = (): Monaco.editor.FindMatch[] => {
    if (!editor || !findText) return [];
    const model = editor.getModel();
    if (!model) return [];
    return model.findMatches(
      findText,
      true,
      options.regex,
      options.matchCase,
      options.wholeWord ? "\\b" : null,
      true,
    );
  };

  useEffect(() => {
    const matches = findAllMatches();
    setMatchCount(matches.length);
    setCurrentMatch(matches.length > 0 ? 1 : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [findText, options, editor]);

  const revealMatch = (index: number) => {
    if (!editor) return;
    const matches = findAllMatches();
    if (matches.length === 0) return;
    const i = ((index % matches.length) + matches.length) % matches.length;
    const range = matches[i].range;
    editor.setSelection(range);
    editor.revealRangeInCenterIfOutsideViewport(range);
    setCurrentMatch(i + 1);
  };

  const handleFindNext = () => revealMatch(currentMatch);
  const handleFindPrev = () => revealMatch(currentMatch - 2);

  const handleReplaceOne = () => {
    if (!editor || !findText) return;
    const selection = editor.getSelection();
    const model = editor.getModel();
    if (!selection || !model) return;

    const selectedText = model.getValueInRange(selection);
    const matchesSelection = options.regex
      ? safeRegex(findText, options)?.test(selectedText) ?? false
      : compareText(selectedText, findText, options);

    if (matchesSelection) {
      editor.executeEdits("find-replace", [
        { range: selection, text: replaceText, forceMoveMarkers: true },
      ]);
    }
    handleFindNext();
  };

  const handleReplaceAll = () => {
    if (!editor || !findText) return;
    const matches = findAllMatches();
    if (matches.length === 0) return;
    editor.executeEdits(
      "find-replace-all",
      matches.map((m) => ({
        range: m.range,
        text: replaceText,
        forceMoveMarkers: true,
      })),
    );
  };

  const handleKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) handleFindPrev();
      else handleFindNext();
    }
  };

  return (
    <div
      className="find-replace-widget"
      data-testid="find-replace-widget"
      role="dialog"
      aria-label="Find and replace"
    >
      <div className="find-replace-header">
        <span>Find &amp; Replace</span>
        <button
          onClick={onClose}
          className="close-button"
          title="Close (Esc)"
          aria-label="Close"
        >
          ✕
        </button>
      </div>

      <div className="find-replace-row">
        <input
          ref={findInputRef}
          type="text"
          placeholder="Find"
          value={findText}
          onChange={(e) => setFindText(e.target.value)}
          onKeyDown={handleKey}
          data-testid="find-input"
        />
        <span
          className="match-count"
          data-testid="find-match-count"
          title="matches"
        >
          {matchCount === 0 ? "No results" : `${currentMatch}/${matchCount}`}
        </span>
        <button onClick={handleFindPrev} title="Previous (Shift+Enter)">↑</button>
        <button onClick={handleFindNext} title="Next (Enter)">↓</button>
      </div>

      <div className="find-replace-row">
        <input
          type="text"
          placeholder="Replace"
          value={replaceText}
          onChange={(e) => setReplaceText(e.target.value)}
          onKeyDown={handleKey}
          data-testid="replace-input"
        />
        <button onClick={handleReplaceOne} title="Replace">
          Replace
        </button>
        <button onClick={handleReplaceAll} title="Replace All">
          All
        </button>
      </div>

      <div className="find-replace-options">
        <label>
          <input
            type="checkbox"
            checked={options.matchCase}
            onChange={(e) =>
              setOptions((o) => ({ ...o, matchCase: e.target.checked }))
            }
          />
          Aa
        </label>
        <label>
          <input
            type="checkbox"
            checked={options.wholeWord}
            onChange={(e) =>
              setOptions((o) => ({ ...o, wholeWord: e.target.checked }))
            }
          />
          Word
        </label>
        <label>
          <input
            type="checkbox"
            checked={options.regex}
            onChange={(e) =>
              setOptions((o) => ({ ...o, regex: e.target.checked }))
            }
          />
          .*
        </label>
      </div>
    </div>
  );
}

function compareText(a: string, b: string, opts: Options): boolean {
  if (opts.matchCase) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

function safeRegex(pattern: string, opts: Options): RegExp | null {
  try {
    const flags = opts.matchCase ? "" : "i";
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}
