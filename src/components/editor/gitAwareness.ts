import type * as Monaco from "monaco-editor";
import {
  gitGetFileChanges,
  gitGetLineBlame,
  type GitFileChanges,
  type GitLineBlame,
  type GitLineChange,
} from "../../lib/tauri";

export const GIT_DIFF_DEBOUNCE_MS = 250;
export const GIT_BLAME_DEBOUNCE_MS = 500;

const GIT_CHANGE_COLORS = {
  added: "#98c379",
  modified: "#e5c07b",
  deleted: "#e06c75",
} as const;

function lineChangeTooltip(change: GitLineChange): string {
  if (change.kind === "deleted") {
    const count = Math.max(1, change.deletedLines);
    return `${count} deleted line${count === 1 ? "" : "s"}`;
  }
  return `${change.kind[0].toUpperCase()}${change.kind.slice(1)} line`;
}

export function buildGitDiffDecorations(
  monaco: typeof Monaco,
  changes: readonly GitLineChange[],
  modelLineCount: number,
): Monaco.editor.IModelDeltaDecoration[] {
  const maxLine = Math.max(1, modelLineCount);
  return changes.map((change) => {
    const lineNumber = Math.min(maxLine, Math.max(1, change.lineNumber));
    const tooltip = lineChangeTooltip(change);
    return {
      range: new monaco.Range(lineNumber, 1, lineNumber, 1),
      options: {
        isWholeLine: true,
        glyphMarginClassName: `git-diff-glyph git-diff-glyph--${change.kind}`,
        glyphMarginHoverMessage: { value: tooltip },
        linesDecorationsClassName: `git-diff-line git-diff-line--${change.kind}`,
        linesDecorationsTooltip: tooltip,
        overviewRuler: {
          color: GIT_CHANGE_COLORS[change.kind],
          position: monaco.editor.OverviewRulerLane.Left,
        },
      },
    };
  });
}

function relativeAge(timestamp: number | null, now: number): string | null {
  if (timestamp === null) return null;
  const elapsed = Math.max(0, Math.floor(now / 1000) - timestamp);
  if (elapsed < 5) return "now";
  if (elapsed < 60) return `${elapsed}s ago`;
  if (elapsed < 3_600) return `${Math.floor(elapsed / 60)}m ago`;
  if (elapsed < 86_400) return `${Math.floor(elapsed / 3_600)}h ago`;
  if (elapsed < 2_592_000) return `${Math.floor(elapsed / 86_400)}d ago`;
  if (elapsed < 31_536_000) return `${Math.floor(elapsed / 2_592_000)}mo ago`;
  return `${Math.floor(elapsed / 31_536_000)}y ago`;
}

export function formatGitBlame(
  blame: GitLineBlame,
  now: number = Date.now(),
): string {
  if (blame.uncommitted) return "You, uncommitted changes";

  const author = blame.author.trim() || "Unknown";
  const age = relativeAge(blame.timestamp, now);
  const summary = blame.summary?.trim().split(/\r?\n/, 1)[0];
  const shortCommit = blame.commit?.slice(0, 7);
  const owner = age ? `${author}, ${age}` : author;
  return [owner, summary, shortCommit].filter(Boolean).join(" • ");
}

export function buildGitBlameDecoration(
  monaco: typeof Monaco,
  blame: GitLineBlame,
  lineMaxColumn: number,
  now: number = Date.now(),
): Monaco.editor.IModelDeltaDecoration {
  const column = Math.max(1, lineMaxColumn);
  return {
    range: new monaco.Range(
      blame.lineNumber,
      column,
      blame.lineNumber,
      column,
    ),
    options: {
      stickiness:
        monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
      showIfCollapsed: true,
      after: {
        content: `   ${formatGitBlame(blame, now)}`,
        inlineClassName: "git-blame-inline",
        cursorStops: monaco.editor.InjectedTextCursorStops.None,
      },
    },
  };
}

type GitAwarenessDependencies = {
  getFileChanges?: (
    filePath: string,
    contents: string,
  ) => Promise<GitFileChanges | null>;
  getLineBlame?: (
    filePath: string,
    contents: string,
    lineNumber: number,
  ) => Promise<GitLineBlame | null>;
  now?: () => number;
  onError?: (error: unknown) => void;
};

export type InstallGitAwarenessOptions = {
  editor: Monaco.editor.IStandaloneCodeEditor;
  monaco: typeof Monaco;
  filePath: string;
  dependencies?: GitAwarenessDependencies;
};

const EMPTY_DISPOSABLE: Monaco.IDisposable = { dispose() {} };

/**
 * Own the Phase 3 Git decorations for one Monaco editor/model pairing.
 *
 * Requests are generation-guarded so a late backend response cannot decorate a
 * replacement Phase 2 model or an editor that has already been disposed.
 */
export function installGitAwareness({
  editor,
  monaco,
  filePath,
  dependencies = {},
}: InstallGitAwarenessOptions): Monaco.IDisposable {
  const expectedModel = editor.getModel();
  if (!expectedModel) return EMPTY_DISPOSABLE;

  const getFileChanges = dependencies.getFileChanges ?? gitGetFileChanges;
  const getLineBlame = dependencies.getLineBlame ?? gitGetLineBlame;
  const now = dependencies.now ?? Date.now;
  const diffDecorations = editor.createDecorationsCollection();
  const blameDecorations = editor.createDecorationsCollection();
  let disposed = false;
  let diffGeneration = 0;
  let blameGeneration = 0;
  let diffTimer: ReturnType<typeof setTimeout> | null = null;
  let blameTimer: ReturnType<typeof setTimeout> | null = null;

  const ownsExpectedModel = () =>
    !disposed && editor.getModel() === expectedModel;

  const clearDiffTimer = () => {
    if (diffTimer !== null) {
      clearTimeout(diffTimer);
      diffTimer = null;
    }
  };
  const clearBlameTimer = () => {
    if (blameTimer !== null) {
      clearTimeout(blameTimer);
      blameTimer = null;
    }
  };

  const scheduleDiff = (delay: number) => {
    clearDiffTimer();
    const generation = ++diffGeneration;
    diffTimer = setTimeout(() => {
      diffTimer = null;
      if (!ownsExpectedModel()) return;
      const contents = expectedModel.getValue();
      void getFileChanges(filePath, contents)
        .then((result) => {
          if (
            !ownsExpectedModel() ||
            generation !== diffGeneration
          ) {
            return;
          }
          diffDecorations.set(
            result && !result.binary
              ? buildGitDiffDecorations(
                  monaco,
                  result.changes,
                  expectedModel.getLineCount(),
                )
              : [],
          );
        })
        .catch((error) => {
          if (!ownsExpectedModel() || generation !== diffGeneration) return;
          diffDecorations.clear();
          dependencies.onError?.(error);
        });
    }, delay);
  };

  const scheduleBlame = (lineNumber: number, delay: number) => {
    clearBlameTimer();
    blameDecorations.clear();
    const generation = ++blameGeneration;
    blameTimer = setTimeout(() => {
      blameTimer = null;
      if (
        !ownsExpectedModel() ||
        lineNumber < 1 ||
        lineNumber > expectedModel.getLineCount()
      ) {
        return;
      }
      const contents = expectedModel.getValue();
      void getLineBlame(filePath, contents, lineNumber)
        .then((result) => {
          if (
            !ownsExpectedModel() ||
            generation !== blameGeneration
          ) {
            return;
          }
          blameDecorations.set(
            result
              ? [
                  buildGitBlameDecoration(
                    monaco,
                    result,
                    expectedModel.getLineMaxColumn(lineNumber),
                    now(),
                  ),
                ]
              : [],
          );
        })
        .catch((error) => {
          if (!ownsExpectedModel() || generation !== blameGeneration) return;
          blameDecorations.clear();
          dependencies.onError?.(error);
        });
    }, delay);
  };

  const contentDisposable = editor.onDidChangeModelContent(() => {
    scheduleDiff(GIT_DIFF_DEBOUNCE_MS);
    const position = editor.getPosition();
    if (position) scheduleBlame(position.lineNumber, GIT_BLAME_DEBOUNCE_MS);
  });
  const cursorDisposable = editor.onDidChangeCursorPosition((event) => {
    scheduleBlame(event.position.lineNumber, GIT_BLAME_DEBOUNCE_MS);
  });

  scheduleDiff(0);
  const initialPosition = editor.getPosition();
  if (initialPosition) {
    scheduleBlame(initialPosition.lineNumber, GIT_BLAME_DEBOUNCE_MS);
  }

  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      diffGeneration += 1;
      blameGeneration += 1;
      clearDiffTimer();
      clearBlameTimer();
      contentDisposable.dispose();
      cursorDisposable.dispose();
      diffDecorations.clear();
      blameDecorations.clear();
    },
  };
}
