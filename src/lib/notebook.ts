import type { Block } from '../state/blocksStore';

export interface BlockNotebook {
  version: string;
  name: string;
  description?: string;
  created_at: number;
  updated_at: number;
  blocks: NotebookBlock[];
}

export interface NotebookBlock {
  command: string;
  cwd: string;
  timestamp: number;
  duration_ms?: number;
  exit_code?: number;
  output: string;
  output_line_count: number;
  bookmarked: boolean;
  ai_explanation?: string | null;
  ai_analysis?: string;
}

/**
 * Convert a runtime `Block` into the wire-format `NotebookBlock` shape.
 * Shared by `exportBlocksToNotebook` and `exportBlockToJson` so the
 * single-block export schema stays in lock-step with the multi-block one.
 */
function blockToNotebookBlock(block: Block): NotebookBlock {
  return {
    command: block.command,
    cwd: block.cwd,
    timestamp: block.timestamp,
    duration_ms: block.durationMs,
    exit_code: block.exitCode,
    output: block.output,
    output_line_count: block.outputLineCount,
    bookmarked: block.bookmarked,
    ai_explanation: block.aiExplanation,
    ai_analysis: block.aiAnalysis,
  };
}

export function exportBlocksToNotebook(
  blocks: Block[],
  name: string,
  description?: string
): BlockNotebook {
  const now = Date.now();

  return {
    version: '1.0.0',
    name,
    description,
    created_at: now,
    updated_at: now,
    blocks: blocks.map(blockToNotebookBlock),
  };
}

/**
 * Render a single block as a JSON string (pretty-printed, 2-space indent)
 * using the same per-block schema as `exportBlocksToNotebook`. The output
 * is a valid `NotebookBlock` so it round-trips through the notebook code.
 *
 * Note: the emitted schema is `NotebookBlock` and intentionally does NOT
 * include `tags`, `pinned`, or `shareId`. Those fields are runtime/UI
 * concerns kept out of the on-disk notebook format. The Phase 1
 * `block_share_create` Rust command preserves the full Rust-side
 * `BlockDto` for share-link payloads; this TS helper exists for
 * clipboard / file-export use cases that must match the existing
 * notebook format produced by `exportBlocksToNotebook`.
 */
export function exportBlockToJson(block: Block): string {
  return JSON.stringify(blockToNotebookBlock(block), null, 2);
}

/**
 * Render a single block as Github-flavored markdown:
 *
 *   ## <command>
 *   _<ISO timestamp> · <duration> · exit <code>_
 *   ````
 *   <output>
 *   ````
 *   > AI: <aiExplanation>   (only when explanation is a non-empty string)
 *
 * The output uses a 4-backtick fence so block output containing a
 * literal ``` line doesn't terminate the fence early.
 *
 * The duration / exit-code segments are omitted when undefined so the
 * metadata line never has dangling `·` separators.
 *
 * Multi-line `aiExplanation` values stay inside the blockquote: every
 * line is prefixed with `> ` so trailing lines aren't rendered as
 * unquoted body text or nested blockquotes.
 */
export function exportBlockToMarkdown(block: Block): string {
  const lines: string[] = [];

  lines.push(`## ${block.command}`);

  const metaParts: string[] = [new Date(block.timestamp).toISOString()];
  if (typeof block.durationMs === 'number') {
    metaParts.push(`${block.durationMs}ms`);
  }
  if (typeof block.exitCode === 'number') {
    metaParts.push(`exit ${block.exitCode}`);
  }
  lines.push(`_${metaParts.join(' · ')}_`);

  lines.push('');
  // Use a 4-backtick fence so blocks whose output contains a literal
  // ``` line don't terminate the fence early. CommonMark allows an
  // N-backtick fence to wrap any sequence of fewer than N backticks.
  lines.push('````');
  lines.push(block.output);
  lines.push('````');

  if (typeof block.aiExplanation === 'string' && block.aiExplanation.length > 0) {
    lines.push('');
    // Multi-line explanations must stay inside the blockquote, otherwise
    // trailing lines render as body text and any line beginning with `>`
    // would become a nested blockquote. Prefix every line with `> `.
    const aiLines = block.aiExplanation.split('\n');
    lines.push(`> AI: ${aiLines[0]}`);
    for (let i = 1; i < aiLines.length; i++) {
      lines.push(`> ${aiLines[i]}`);
    }
  }

  // Trim trailing whitespace on each line, then join.
  return lines.map(line => line.replace(/[ \t]+$/g, '')).join('\n');
}

export function importNotebookToBlocks(
  notebook: BlockNotebook,
  targetTabId: string
): Block[] {
  return notebook.blocks.map(notebookBlock => ({
    id: `block-${crypto.randomUUID()}`,
    tabId: targetTabId,
    command: notebookBlock.command,
    cwd: notebookBlock.cwd,
    timestamp: notebookBlock.timestamp,
    durationMs: notebookBlock.duration_ms,
    exitCode: notebookBlock.exit_code,
    output: notebookBlock.output,
    outputLineCount: notebookBlock.output_line_count,
    collapsed: false,
    bookmarked: notebookBlock.bookmarked,
    tags: [],
    pinned: false,
    aiExplanation: notebookBlock.ai_explanation,
    aiAnalysis: notebookBlock.ai_analysis,
  }));
}

export function downloadNotebook(notebook: BlockNotebook): void {
  const json = JSON.stringify(notebook, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  // Sanitize filename
  const filename = notebook.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  link.download = `${filename}.ccienb`;

  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}

export async function parseNotebookFile(file: File): Promise<BlockNotebook> {
  const text = await file.text();
  const parsed = JSON.parse(text);

  // Basic validation
  if (!parsed.version || !parsed.name || !Array.isArray(parsed.blocks)) {
    throw new Error('Invalid notebook format');
  }

  return parsed as BlockNotebook;
}
