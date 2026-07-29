import { describe, it, expect } from 'vitest';
import {
  exportBlocksToNotebook,
  importNotebookToBlocks,
  exportBlockToMarkdown,
  exportBlockToJson,
  type BlockNotebook,
  type NotebookBlock,
} from './notebook';
import type { Block } from '../state/blocksStore';

describe('notebook', () => {
  const mockBlocks: Block[] = [
    {
      id: 'block-1',
      tabId: 'tab-1',
      command: 'ls -la',
      cwd: '/home/user',
      timestamp: 1714600000000,
      durationMs: 150,
      exitCode: 0,
      output: 'total 8\ndrwxr-xr-x  2 user user 4096 May  1 10:00 .\ndrwxr-xr-x 10 user user 4096 May  1 09:00 ..',
      outputLineCount: 3,
      collapsed: false,
      bookmarked: true,
      tags: [],
      pinned: false,
    },
    {
      id: 'block-2',
      tabId: 'tab-1',
      command: 'echo "hello world"',
      cwd: '/home/user',
      timestamp: 1714600100000,
      durationMs: 50,
      exitCode: 0,
      output: 'hello world',
      outputLineCount: 1,
      collapsed: false,
      bookmarked: false,
      tags: [],
      pinned: false,
      aiExplanation: 'This command prints "hello world" to stdout',
    },
  ];

  it('exports blocks to notebook format', () => {
    const notebook = exportBlocksToNotebook(
      mockBlocks,
      'Test Session',
      'A test session with two commands'
    );

    expect(notebook.version).toBe('1.0.0');
    expect(notebook.name).toBe('Test Session');
    expect(notebook.description).toBe('A test session with two commands');
    expect(notebook.blocks).toHaveLength(2);

    // Check first block
    expect(notebook.blocks[0].command).toBe('ls -la');
    expect(notebook.blocks[0].cwd).toBe('/home/user');
    expect(notebook.blocks[0].timestamp).toBe(1714600000000);
    expect(notebook.blocks[0].duration_ms).toBe(150);
    expect(notebook.blocks[0].exit_code).toBe(0);
    expect(notebook.blocks[0].output_line_count).toBe(3);
    expect(notebook.blocks[0].bookmarked).toBe(true);

    // Check second block
    expect(notebook.blocks[1].command).toBe('echo "hello world"');
    expect(notebook.blocks[1].bookmarked).toBe(false);
    expect(notebook.blocks[1].ai_explanation).toBe('This command prints "hello world" to stdout');
  });

  it('imports notebook to blocks', () => {
    const notebook: BlockNotebook = {
      version: '1.0.0',
      name: 'Test Session',
      description: 'A test session',
      created_at: 1714600000000,
      updated_at: 1714600000000,
      blocks: [
        {
          command: 'pwd',
          cwd: '/tmp',
          timestamp: 1714600000000,
          duration_ms: 10,
          exit_code: 0,
          output: '/tmp',
          output_line_count: 1,
          bookmarked: false,
        },
        {
          command: 'date',
          cwd: '/tmp',
          timestamp: 1714600100000,
          duration_ms: 20,
          exit_code: 0,
          output: 'Fri May  2 10:00:00 UTC 2026',
          output_line_count: 1,
          bookmarked: true,
          ai_explanation: 'Displays the current date and time',
        },
      ],
    };

    const blocks = importNotebookToBlocks(notebook, 'target-tab-123');

    expect(blocks).toHaveLength(2);

    // Check first block
    expect(blocks[0].command).toBe('pwd');
    expect(blocks[0].cwd).toBe('/tmp');
    expect(blocks[0].tabId).toBe('target-tab-123');
    expect(blocks[0].timestamp).toBe(1714600000000);
    expect(blocks[0].durationMs).toBe(10);
    expect(blocks[0].exitCode).toBe(0);
    expect(blocks[0].output).toBe('/tmp');
    expect(blocks[0].outputLineCount).toBe(1);
    expect(blocks[0].bookmarked).toBe(false);
    expect(blocks[0].collapsed).toBe(false);

    // Check second block with AI explanation
    expect(blocks[1].command).toBe('date');
    expect(blocks[1].bookmarked).toBe(true);
    expect(blocks[1].aiExplanation).toBe('Displays the current date and time');
  });

  it('preserves bookmarks and metadata', () => {
    const originalBlocks: Block[] = [
      {
        id: 'block-1',
        tabId: 'tab-1',
        command: 'cat important.txt',
        cwd: '/docs',
        timestamp: 1714600000000,
        durationMs: 100,
        exitCode: 0,
        output: 'Important content here',
        outputLineCount: 1,
        collapsed: false,
        bookmarked: true,
        tags: [],
        pinned: false,
        aiExplanation: 'Reads and displays the contents of important.txt',
      },
    ];

    // Export -> Import cycle
    const notebook = exportBlocksToNotebook(originalBlocks, 'Round Trip Test');
    const importedBlocks = importNotebookToBlocks(notebook, 'new-tab-456');

    // Verify metadata preserved
    expect(importedBlocks[0].command).toBe(originalBlocks[0].command);
    expect(importedBlocks[0].cwd).toBe(originalBlocks[0].cwd);
    expect(importedBlocks[0].bookmarked).toBe(true);
    expect(importedBlocks[0].aiExplanation).toBe('Reads and displays the contents of important.txt');
    expect(importedBlocks[0].durationMs).toBe(100);
    expect(importedBlocks[0].exitCode).toBe(0);
  });
});

describe('single-block export', () => {
  const baseBlock: Block = {
    id: 'block-md-1',
    tabId: 'tab-1',
    command: 'echo hello',
    cwd: '/home/user',
    timestamp: 1714600000000,
    durationMs: 120,
    exitCode: 0,
    output: 'hello',
    outputLineCount: 1,
    collapsed: false,
    bookmarked: false,
    tags: [],
    pinned: false,
  };

  it('exportBlockToJson produces parseable JSON whose shape matches NotebookBlock', () => {
    const json = exportBlockToJson(baseBlock);
    const parsed = JSON.parse(json);

    // Type-level: assigning to NotebookBlock should compile.
    const asNotebookBlock: NotebookBlock = parsed;
    expect(asNotebookBlock.command).toBe('echo hello');
    expect(asNotebookBlock.cwd).toBe('/home/user');
    expect(asNotebookBlock.timestamp).toBe(1714600000000);
    expect(asNotebookBlock.duration_ms).toBe(120);
    expect(asNotebookBlock.exit_code).toBe(0);
    expect(asNotebookBlock.output).toBe('hello');
    expect(asNotebookBlock.output_line_count).toBe(1);
    expect(asNotebookBlock.bookmarked).toBe(false);
  });

  it('exportBlockToJson round-trips against the notebook per-block schema', () => {
    const single = exportBlockToJson(baseBlock);
    const wholeNotebook = exportBlocksToNotebook([baseBlock], 'unused');

    const parsedSingle = JSON.parse(single);
    expect(parsedSingle).toEqual(wholeNotebook.blocks[0]);
  });

  it('exportBlockToJson is pretty-printed with 2-space indent', () => {
    const json = exportBlockToJson(baseBlock);
    expect(json).toContain('\n  "command":');
  });

  it('exportBlockToMarkdown includes the command as a heading', () => {
    const md = exportBlockToMarkdown(baseBlock);
    expect(md).toMatch(/^## echo hello/m);
  });

  it('exportBlockToMarkdown includes the output inside a fenced code block', () => {
    const md = exportBlockToMarkdown(baseBlock);
    // Default fence is 4 backticks (so 3-backtick output survives).
    expect(md).toContain('````\nhello\n````');
  });

  it('exportBlockToMarkdown uses an ISO timestamp', () => {
    const md = exportBlockToMarkdown(baseBlock);
    const iso = new Date(baseBlock.timestamp).toISOString();
    expect(md).toContain(iso);
  });

  it('exportBlockToMarkdown includes duration when defined', () => {
    const md = exportBlockToMarkdown(baseBlock);
    expect(md).toContain('120ms');
  });

  it('exportBlockToMarkdown omits the duration when durationMs is undefined', () => {
    const block: Block = { ...baseBlock, durationMs: undefined };
    const md = exportBlockToMarkdown(block);
    expect(md).not.toContain('ms');
    // No dangling separators on the metadata line.
    expect(md).not.toMatch(/·\s*·/);
    expect(md).not.toMatch(/·\s*$/m);
  });

  it('exportBlockToMarkdown omits the exit code when undefined', () => {
    const block: Block = { ...baseBlock, exitCode: undefined };
    const md = exportBlockToMarkdown(block);
    expect(md).not.toContain('exit ');
  });

  it('exportBlockToMarkdown drops the metadata line entirely when nothing to show', () => {
    const block: Block = {
      ...baseBlock,
      durationMs: undefined,
      exitCode: undefined,
    };
    const md = exportBlockToMarkdown(block);
    // Only the ISO timestamp on the italic line.
    const iso = new Date(block.timestamp).toISOString();
    expect(md).toContain(`_${iso}_`);
  });

  it('exportBlockToMarkdown includes the AI explanation as a blockquote when present', () => {
    const block: Block = {
      ...baseBlock,
      aiExplanation: 'Prints hello to stdout.',
    };
    const md = exportBlockToMarkdown(block);
    expect(md).toContain('> AI: Prints hello to stdout.');
  });

  it('exportBlockToMarkdown skips the AI blockquote when explanation is null/empty', () => {
    const blockNull: Block = { ...baseBlock, aiExplanation: null };
    const blockEmpty: Block = { ...baseBlock, aiExplanation: '' };
    expect(exportBlockToMarkdown(blockNull)).not.toContain('> AI:');
    expect(exportBlockToMarkdown(blockEmpty)).not.toContain('> AI:');
  });

  it('exportBlockToMarkdown survives output that contains a triple-backtick line', () => {
    const block: Block = {
      ...baseBlock,
      output: 'before\n```\ninside fence\n```\nafter',
    };
    const md = exportBlockToMarkdown(block);

    // Outer fence must be at least 4 backticks so the inner ``` lines
    // don't terminate the fence early.
    expect(md).toMatch(/\n````+\n/);

    // The inner ``` lines must survive verbatim in the output.
    expect(md).toContain('\n```\ninside fence\n```\n');

    // Sanity: the fence appears exactly twice (open + close), not four
    // times — proving the 3-backtick lines didn't introduce extra fences.
    const fenceMatches = md.match(/^````+$/gm) ?? [];
    expect(fenceMatches).toHaveLength(2);
  });

  it('exportBlockToMarkdown keeps multi-line AI explanations inside the blockquote', () => {
    const block: Block = {
      ...baseBlock,
      aiExplanation: 'First line.\nSecond line.\n> looks like a quote\nFourth line.',
    };
    const md = exportBlockToMarkdown(block);

    // First line uses the `> AI:` prefix; every subsequent line uses `> `.
    expect(md).toContain('> AI: First line.');
    expect(md).toContain('\n> Second line.');
    expect(md).toContain('\n> > looks like a quote');
    expect(md).toContain('\n> Fourth line.');

    // No bare (un-quoted) explanation line should leak into the body.
    expect(md).not.toMatch(/^Second line\.$/m);
    expect(md).not.toMatch(/^Fourth line\.$/m);
  });
});
