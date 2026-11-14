import { describe, it, expect, vi, beforeEach } from 'vitest';

// #15: a restored Windows tab showed history but no prompt, and typed text
// never echoed. ConPTY's first output is a cursor position query (ESC[6n) and
// it prints nothing until it gets the reply. That output can arrive before the
// pty_spawn response, and xterm's reply was dropped because input was only
// wired after the spawn resolved.

const ptySpawn = vi.fn(async (_arg?: any) => 'pty-1');
const ptyWrite = vi.fn(async (_id?: any, _bytes?: any) => {});
vi.mock('./tauri', () => ({
  ptySpawn: (arg?: any) => ptySpawn(arg),
  ptyKill: vi.fn(async () => {}),
  ptyResize: vi.fn(async () => {}),
  ptyWrite: (id?: any, bytes?: any) => ptyWrite(id, bytes),
  terminalLaunchSavedSsh: vi.fn(async () => {}),
}));

// Like xterm, data reaches only the listeners registered when it is emitted.
function installFakeXterm() {
  const made: any[] = [];
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
    constructor(options: Record<string, unknown>) { this.options = options; made.push(this); }
  };
  (window as any).FitAddon = { FitAddon: class { fit = vi.fn(); } };
  (window as any).SearchAddon = {
    SearchAddon: class {
      findNext = vi.fn(); findPrevious = vi.fn(); clearDecorations = vi.fn();
      onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() })); dispose = vi.fn();
    },
  };
  return made;
}

import * as reg from './terminalRegistry';

beforeEach(() => {
  reg.__resetForTest();
  ptySpawn.mockReset();
  ptyWrite.mockClear();
  installFakeXterm();
});

describe('#15 restored Windows tab never gets a prompt', () => {
  it('delivers the reply to a cursor query that arrives before the spawn resolves', async () => {
    let resolveSpawn!: (id: string) => void;
    let onEvent!: (event: any) => void;
    ptySpawn.mockImplementationOnce((arg: any) => {
      onEvent = arg.onEvent;
      return new Promise<string>((resolve) => { resolveSpawn = resolve; });
    });
    const entry = reg.getOrCreate('restored', {
      shell: 'powershell.exe',
      cwd: 'C:/',
      preferredTabId: 'restored',
      replayBytes: Array.from(new TextEncoder().encode('PS C:\\> ')),
      skipTabRegistration: true,
    });

    // ConPTY's first output, then xterm's reply, both before pty_spawn returns.
    onEvent({ type: 'output', bytes: Array.from(new TextEncoder().encode('\x1b[6n')) });
    entry.xterm.emitData('\x1b[3;9R');
    resolveSpawn('restored');
    await Promise.resolve();
    await Promise.resolve();

    const sent = ptyWrite.mock.calls.map((call) => [call[0], new TextDecoder().decode(call[1])]);
    expect(sent).toContainEqual(['restored', '\x1b[3;9R']);
  });
});
