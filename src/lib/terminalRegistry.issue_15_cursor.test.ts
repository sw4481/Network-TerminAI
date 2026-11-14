import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// #15 follow-up: a restored Windows tab that had a full screen of history (a
// Claude Code session, for example) still never got a prompt. ConPTY ignores
// a cursor position reply outside the size it was spawned with (80x24 for a
// restored tab), and the tab is fitted to the window before the reply, so the
// cursor below a full screen of history was reported at row 61.

const ptySpawn = vi.fn(async (_arg?: any) => 'pty-1');
const ptyWrite = vi.fn(async (_id?: any, _bytes?: any) => {});
const ptyResize = vi.fn(async (_id?: any, _cols?: any, _rows?: any) => {});
vi.mock('./tauri', () => ({
  ptySpawn: (arg?: any) => ptySpawn(arg),
  ptyKill: vi.fn(async () => {}),
  ptyResize: (id?: any, cols?: any, rows?: any) => ptyResize(id, cols, rows),
  ptyWrite: (id?: any, bytes?: any) => ptyWrite(id, bytes),
  terminalLaunchSavedSsh: vi.fn(async () => {}),
}));

// Like xterm, data reaches only the listeners registered when it is emitted.
function installFakeXterm() {
  (window as any).Terminal = class {
    cols = 80; rows = 24;
    listeners: ((data: string) => void)[] = [];
    onData = vi.fn((listener: (data: string) => void) => {
      this.listeners.push(listener);
      return { dispose: vi.fn() };
    });
    emitData(data: string) { this.listeners.forEach((listener) => listener(data)); }
    loadAddon = vi.fn();
    open = vi.fn();
    refresh = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    buffer = { active: { baseY: 0, viewportY: 0, cursorY: 0, getLine: vi.fn(() => null) } };
    registerMarker = vi.fn(() => ({ dispose: vi.fn(), onDispose: vi.fn() }));
    registerDecoration = vi.fn(() => ({ dispose: vi.fn(), onRender: vi.fn() }));
    write = vi.fn((_data: unknown, callback?: () => void) => callback?.());
    attachCustomKeyEventHandler = vi.fn();
    getSelection = vi.fn(() => '');
    options: Record<string, unknown> = {};
    constructor(options: Record<string, unknown>) { this.options = options; }
  };
  (window as any).FitAddon = { FitAddon: class { fit = vi.fn(); } };
  (window as any).SearchAddon = {
    SearchAddon: class {
      findNext = vi.fn(); findPrevious = vi.fn(); clearDecorations = vi.fn();
      onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() })); dispose = vi.fn();
    },
  };
}

import * as reg from './terminalRegistry';

const ESC = '\x1b';
const sentText = () => ptyWrite.mock.calls.map((call) => new TextDecoder().decode(call[1]));

beforeEach(() => {
  reg.__resetForTest();
  ptySpawn.mockClear();
  ptyWrite.mockClear();
  ptyResize.mockClear();
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Win32');
  installFakeXterm();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('#15 restored Windows tab with a full screen of history', () => {
  it('reports a cursor position inside the spawn size and resizes the PTY afterwards', async () => {
    let resolveSpawn!: (id: string) => void;
    ptySpawn.mockImplementationOnce(
      () => new Promise<string>((resolve) => { resolveSpawn = resolve; }),
    );
    const entry = reg.getOrCreate('restored', {
      shell: 'powershell.exe',
      cwd: 'C:/',
      preferredTabId: 'restored',
      replayBytes: Array.from(new TextEncoder().encode('history\r\n'.repeat(80))),
      skipTabRegistration: true,
    });
    expect(ptySpawn.mock.calls[0][0]).toMatchObject({ cols: 80, rows: 24 });

    // The tab is fitted to the window, then xterm answers ConPTY's ESC[6n
    // with the cursor on the last row.
    entry.xterm.cols = 135;
    entry.xterm.rows = 61;
    entry.xterm.emitData(`${ESC}[61;1R`);
    resolveSpawn('restored');
    await Promise.resolve();
    await Promise.resolve();

    expect(sentText()).toEqual([`${ESC}[24;1R`]);
    // The history scrolls up 37 rows so xterm's cursor matches the reply.
    const writes = entry.xterm.write.mock.calls.map((call: any[]) => call[0]);
    expect(writes).toContain(`${ESC}[r${ESC}[61;1H${'\n'.repeat(37)}${ESC}[24;1H`);
    expect(ptyResize).toHaveBeenCalledWith('restored', 135, 61);
  });

  it('passes a reply that already fits through, and leaves later replies alone', async () => {
    const entry = reg.getOrCreate('fresh', { shell: 'powershell.exe', cwd: 'C:/' });
    await Promise.resolve();
    await Promise.resolve();
    entry.xterm.emitData(`${ESC}[1;1R`);
    entry.xterm.emitData(`${ESC}[61;1R`); // a later query, from a program in the shell
    expect(sentText()).toEqual([`${ESC}[1;1R`, `${ESC}[61;1R`]);
  });
});
