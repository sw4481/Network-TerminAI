import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tauri PTY calls.
const ptySpawn = vi.fn(async (_arg?: any) => 'pty-1');
const ptyKill = vi.fn(async (_arg?: any) => {});
const ptyWrite = vi.fn(async (_id?: any, _bytes?: any) => {});
const ptyResize = vi.fn(async (_id?: any, _cols?: any, _rows?: any) => {});
const terminalLaunchSavedSsh = vi.fn(async (_id?: any, _connectionId?: any) => {});
vi.mock('./tauri', () => ({
  ptySpawn: (arg?: any) => ptySpawn(arg),
  ptyKill: (arg?: any) => ptyKill(arg),
  ptyResize: (id?: any, cols?: any, rows?: any) => ptyResize(id, cols, rows),
  ptyWrite: (id?: any, bytes?: any) => ptyWrite(id, bytes),
  terminalLaunchSavedSsh: (id?: any, connectionId?: any) =>
    terminalLaunchSavedSsh(id, connectionId),
}));

/** Decode the bytes passed to a ptyWrite mock call back into a string. */
function writtenText(call: any[]): string {
  return new TextDecoder().decode(call[1]);
}

// Minimal fake xterm + addons on window (CDN shape).
function installFakeXterm() {
  const made: any[] = [];
  searchAddons.length = 0;
  (window as any).Terminal = class {
    cols = 80; rows = 24;
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    loadedAddons: any[] = [];
    loadAddon = vi.fn((addon: any) => this.loadedAddons.push(addon));
    open = vi.fn();
    refresh = vi.fn();
    focus = vi.fn();
    dispose = vi.fn(() => this.loadedAddons.forEach((addon) => addon.dispose?.()));
    buffer = {
      active: {
        baseY: 0,
        viewportY: 0,
        cursorY: 0,
        getLine: vi.fn(() => ({ translateToString: () => 'connected' })),
      },
    };
    registerMarker = vi.fn(() => ({ dispose: vi.fn(), onDispose: vi.fn() }));
    registerDecoration = vi.fn(() => ({ dispose: vi.fn(), onRender: vi.fn() }));
    write = vi.fn((_data: unknown, callback?: () => void) => callback?.());
    attachCustomKeyEventHandler = vi.fn();
    getSelection = vi.fn(() => '');
    options: Record<string, unknown> = {};
    constructor(options: Record<string, unknown>) { this.options = options; made.push(this); }
  };
  (window as any).FitAddon = { FitAddon: class { fit = vi.fn(); } };
  (window as any).WebLinksAddon = { WebLinksAddon: class {} };
  (window as any).ClipboardAddon = { ClipboardAddon: class {} };
  (window as any).SearchAddon = {
    SearchAddon: class {
      findNext = vi.fn(() => true);
      findPrevious = vi.fn(() => true);
      clearDecorations = vi.fn();
      onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
      dispose = vi.fn();
      constructor() { searchAddons.push(this); }
    },
  };
  return made;
}

const searchAddons: any[] = [];

import * as reg from './terminalRegistry';

beforeEach(() => {
  reg.__resetForTest();
  ptySpawn.mockClear();
  ptyKill.mockClear();
  ptyWrite.mockClear();
  ptyResize.mockClear();
  terminalLaunchSavedSsh.mockClear();
  installFakeXterm();
});

const OPTS = { shell: '/bin/zsh', cwd: '/home' };

describe('terminalRegistry lifecycle', () => {
  it('constructs every registry xterm through the shared terminal options adapter', () => {
    const entry = reg.getOrCreate('t-options', OPTS);
    expect(entry.xterm.options).toMatchObject({
      fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
      theme: { background: '#0F1114', brightWhite: '#EEEEEC' },
    });
  });
  it('getOrCreate spawns one PTY and reuses the entry on second call', () => {
    const a = reg.getOrCreate('t1', OPTS);
    const b = reg.getOrCreate('t1', OPTS);
    expect(a).toBe(b);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
  });

  it('owns one search addon per xterm and retains it across detach/reattach', () => {
    const first = reg.getOrCreate('search-1', OPTS);
    const second = reg.getOrCreate('search-2', OPTS);
    expect(searchAddons).toHaveLength(2);
    expect(first.searchAddon).not.toBe(second.searchAddon);

    const slot = document.createElement('div');
    reg.attach('search-1', slot);
    reg.detach('search-1');
    reg.attach('search-1', slot);
    expect(reg.getOrCreate('search-1', OPTS).searchAddon).toBe(first.searchAddon);
  });

  it('routes narrow search operations to the owning addon', () => {
    const entry = reg.getOrCreate('search-route', OPTS);
    const handle = reg.searchHandleFor('search-route');
    expect(handle).not.toBeNull();
    handle!.findNext('needle', expect.anything() as never);
    handle!.findPrevious('needle', expect.anything() as never);
    handle!.clearDecorations();
    handle!.focus();
    expect(entry.searchAddon.findNext).toHaveBeenCalledWith('needle', expect.anything());
    expect(entry.searchAddon.findPrevious).toHaveBeenCalledWith('needle', expect.anything());
    expect(entry.searchAddon.clearDecorations).toHaveBeenCalled();
    expect(entry.xterm.focus).toHaveBeenCalled();
    expect(reg.searchHandleFor('missing')).toBeNull();
  });

  it('attach appends the persistent el into the slot and fits', () => {
    const e = reg.getOrCreate('t1', OPTS);
    const slot = document.createElement('div');
    reg.attach('t1', slot);
    expect(slot.contains(e.el)).toBe(true);
    expect(e.fitAddon.fit).toHaveBeenCalled();
  });

  it('defers xterm.open until first attach (el must be in the DOM), once only', () => {
    const e = reg.getOrCreate('t1', OPTS);
    // Not opened at create time — el is still detached.
    expect(e.xterm.open).not.toHaveBeenCalled();
    expect(e.opened).toBe(false);

    const slotA = document.createElement('div');
    reg.attach('t1', slotA);
    expect(e.xterm.open).toHaveBeenCalledTimes(1);
    expect(e.xterm.open).toHaveBeenCalledWith(e.el);
    expect(e.opened).toBe(true);

    // Reattaching (e.g. a split) must NOT re-open.
    reg.detach('t1');
    const slotB = document.createElement('div');
    reg.attach('t1', slotB);
    expect(e.xterm.open).toHaveBeenCalledTimes(1);
  });

  it('detach removes el from DOM but keeps the entry alive', () => {
    const e = reg.getOrCreate('t1', OPTS);
    const slot = document.createElement('div');
    reg.attach('t1', slot);
    reg.detach('t1');
    expect(slot.contains(e.el)).toBe(false);
    expect(reg.has('t1')).toBe(true);
  });

  it('attach -> detach -> attach reuses same xterm, no new PTY (split sim)', () => {
    const e1 = reg.getOrCreate('t1', OPTS);
    const slotA = document.createElement('div');
    const slotB = document.createElement('div');
    reg.attach('t1', slotA);
    reg.detach('t1');
    reg.attach('t1', slotB);
    const e2 = reg.getOrCreate('t1', OPTS);
    expect(e2.xterm).toBe(e1.xterm);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(slotB.contains(e1.el)).toBe(true);
  });

  it('dispose kills PTY, disposes xterm, removes entry; idempotent', async () => {
    const e = reg.getOrCreate('t1', OPTS);
    reg.dispose('t1');
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ptyKill).toHaveBeenCalledTimes(1);
    expect(e.xterm.dispose).toHaveBeenCalledTimes(1);
    expect(e.searchAddon.dispose).toHaveBeenCalledTimes(1);
    expect(reg.has('t1')).toBe(false);
    reg.dispose('t1'); // no throw, no extra calls
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ptyKill).toHaveBeenCalledTimes(1);
  });
});

describe('terminalRegistry live appearance updates', () => {
  it('uses the latest approved appearance snapshot for a newly created terminal', async () => {
    const settings = (await import('../theme/defaults')).createDefaultAppearanceSettings();
    settings.terminal = { ...settings.terminal, preset: 'custom', foreground: '#ABCDEF', fontSize: 18 };
    reg.applyAppearanceSettings(settings);

    const entry = reg.getOrCreate('t-new-snapshot', OPTS);

    expect(entry.xterm.options).toMatchObject({
      fontSize: 18,
      theme: { foreground: '#ABCDEF' },
    });
  });

  it('updates existing xterm options in place without creating, killing, or reconnecting the PTY', async () => {
    const entry = reg.getOrCreate('t-live', OPTS);
    await Promise.resolve();
    const originalXterm = entry.xterm;
    const originalPtyId = entry.ptyTabId;
    const settings = (await import('../theme/defaults')).createDefaultAppearanceSettings();
    settings.terminal = { ...settings.terminal, preset: 'custom', foreground: '#ABCDEF' };

    reg.applyAppearanceSettings(settings);

    expect(entry.xterm).toBe(originalXterm);
    expect(entry.ptyTabId).toBe(originalPtyId);
    expect(entry.xterm.options).toMatchObject({ theme: { foreground: '#ABCDEF' } });
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it('fits, refreshes, and resizes the existing PTY only when font metrics change', async () => {
    const entry = reg.getOrCreate('t-metrics', OPTS);
    await Promise.resolve();
    const settings = (await import('../theme/defaults')).createDefaultAppearanceSettings();
    settings.terminal = { ...settings.terminal, fontSize: 16 };

    reg.applyAppearanceSettings(settings);

    expect(entry.fitAddon.fit).toHaveBeenCalled();
    expect(entry.xterm.refresh).toHaveBeenCalledWith(0, entry.xterm.rows - 1);
    expect(ptyResize).toHaveBeenCalledWith('pty-1', entry.xterm.cols, entry.xterm.rows);
  });

  it('does not resize when only terminal colors change', async () => {
    reg.getOrCreate('t-colors', OPTS);
    await Promise.resolve();
    ptyResize.mockClear();
    const settings = (await import('../theme/defaults')).createDefaultAppearanceSettings();
    settings.terminal = { ...settings.terminal, preset: 'custom', background: '#111111' };

    reg.applyAppearanceSettings(settings);

    expect(ptyResize).not.toHaveBeenCalled();
  });
});

describe('terminalRegistry session wiring', () => {
  it('writes PTY output bytes to the xterm', async () => {
    const e = reg.getOrCreate('t1', OPTS);
    await Promise.resolve(); // let ptySpawn resolve
    // grab the onEvent passed to ptySpawn
    const onEvent = ptySpawn.mock.calls[0][0].onEvent as (ev: any) => void;
    onEvent({ type: 'output', bytes: Array.from(new TextEncoder().encode('hello')) });
    expect(e.xterm.write).toHaveBeenCalled();
  });

  it('wires syntax decoration and alternate-screen events without changing output bytes', async () => {
    const e = reg.getOrCreate('t-syntax', OPTS);
    await Promise.resolve();
    const { useTerminalConnectionStore } = await import('../state/terminalConnectionStore');
    useTerminalConnectionStore.getState().bind({
      terminalId: 't-syntax',
      backendPtyId: 'pty-1',
      connectionId: 'connection-1',
      displayName: 'Core',
      vendor: 'cisco',
      platform: 'iosxe',
      accentColor: null,
      syntaxHighlightingEnabled: true,
      syntaxProfile: 'auto',
      sshCommand: 'ssh core',
    });
    e.xterm.registerDecoration.mockClear();
    const onEvent = ptySpawn.mock.calls[0][0].onEvent as (ev: any) => void;
    const bytes = Array.from(new TextEncoder().encode('connected'));

    onEvent({ type: 'output', bytes });
    expect(e.xterm.write.mock.calls.at(-1)?.[0]).toEqual(new Uint8Array(bytes));
    expect(e.xterm.registerDecoration).toHaveBeenCalled();

    onEvent({ type: 'enter_alt_screen' });
    e.xterm.registerDecoration.mockClear();
    onEvent({ type: 'output', bytes });
    expect(e.xterm.registerDecoration).not.toHaveBeenCalled();
    onEvent({ type: 'exit_alt_screen' });
    onEvent({ type: 'output', bytes });
    expect(e.xterm.registerDecoration).toHaveBeenCalled();
  });

  it('tracks saved SSH lifecycle from matching command events, not disconnect text', async () => {
    reg.getOrCreate('t-lifecycle', OPTS);
    await Promise.resolve();
    const { useTerminalConnectionStore } = await import('../state/terminalConnectionStore');
    useTerminalConnectionStore.getState().bind({
      terminalId: 't-lifecycle', backendPtyId: 'pty-1', connectionId: 'connection-1',
      displayName: 'Core', vendor: 'cisco', platform: 'iosxe', accentColor: null,
      syntaxHighlightingEnabled: false, syntaxProfile: 'auto',
      sshCommand: 'ssh admin@core',
    });
    const onEvent = ptySpawn.mock.calls[0][0].onEvent as (ev: any) => void;
    onEvent({ type: 'command_start', cmd: 'ssh admin@core' });
    expect(useTerminalConnectionStore.getState().get('t-lifecycle')?.lifecycle).toBe('connected');
    onEvent({
      type: 'output',
      bytes: Array.from(new TextEncoder().encode('Connection to core closed')),
    });
    expect(useTerminalConnectionStore.getState().get('t-lifecycle')?.lifecycle).toBe('connected');
    onEvent({ type: 'command_end', exit_code: 255 });
    expect(useTerminalConnectionStore.getState().get('t-lifecycle')).toMatchObject({
      lifecycle: 'disconnected', exit_status: 255,
    });
  });

  it('delegates the saved SSH launch and binding to the backend', async () => {
    reg.getOrCreate('t-saved-bind', OPTS);
    await Promise.resolve();

    window.dispatchEvent(new CustomEvent('ssh-connect', {
      detail: {
        command: 'ssh admin@core',
        targetTabId: 'pty-1',
        connection: {
          id: 'connection-1',
          display_name: 'Core',
          vendor: 'cisco',
          platform: 'iosxe',
          accent_color: null,
          syntax_highlighting_enabled: true,
          syntax_profile: 'auto',
        },
        credentials: { host: 'core', user: 'admin', password: null },
      },
    }));
    await Promise.resolve();
    await Promise.resolve();

    expect(ptyWrite).not.toHaveBeenCalled();
    expect(terminalLaunchSavedSsh).toHaveBeenCalledWith('pty-1', 'connection-1');
  });

  it('exit event disposes the terminal', async () => {
    reg.getOrCreate('t1', OPTS);
    await Promise.resolve();
    const onEvent = ptySpawn.mock.calls[0][0].onEvent as (ev: any) => void;
    onEvent({ type: 'exit' });
    expect(reg.has('t1')).toBe(false);
  });

  it('applies the Linux copy/paste matrix while preserving no-selection Ctrl+C', async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    const readText = vi.fn(async () => 'show version');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText, writeText },
    });
    const entry = reg.getOrCreate('clipboard-linux', OPTS);
    await Promise.resolve();
    const handler = entry.xterm.attachCustomKeyEventHandler.mock.calls[0][0];
    const base = {
      type: 'keydown',
      altKey: false,
      metaKey: false,
      preventDefault: vi.fn(),
    };

    entry.xterm.getSelection.mockReturnValue('selected output');
    expect(handler({ ...base, key: 'C', ctrlKey: true, shiftKey: true })).toBe(false);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith('selected output');

    entry.xterm.getSelection.mockReturnValue('');
    expect(handler({ ...base, key: 'c', ctrlKey: true, shiftKey: false })).toBe(true);

    ptyWrite.mockClear();
    expect(handler({ ...base, key: 'V', ctrlKey: true, shiftKey: true })).toBe(false);
    await vi.waitFor(() => expect(ptyWrite).toHaveBeenCalledTimes(1));
    expect(readText).toHaveBeenCalledTimes(1);
    expect(writtenText(ptyWrite.mock.calls[0])).toBe('show version');
    platform.mockRestore();
  });
});

describe('getSelection', () => {
  it('returns the live xterm selection for an existing entry', () => {
    const e = reg.getOrCreate('t1', OPTS);
    e.xterm.getSelection = vi.fn(() => 'selected text');
    expect(reg.getSelection('t1')).toBe('selected text');
  });

  it('returns empty string for a terminalId with no registry entry', () => {
    expect(reg.getSelection('does-not-exist')).toBe('');
  });
});

describe('runWhenReady (run-in-terminal delivery)', () => {
  it('writes immediately with a trailing newline when the PTY is already live', async () => {
    reg.getOrCreate('t1', OPTS);
    await Promise.resolve(); // let ptySpawn resolve so ptyTabId is set
    ptyWrite.mockClear(); // ignore any setup writes

    reg.runWhenReady('t1', 'ansible-playbook site.yml');

    expect(ptyWrite).toHaveBeenCalledTimes(1);
    expect(ptyWrite.mock.calls[0][0]).toBe('pty-1');
    expect(writtenText(ptyWrite.mock.calls[0])).toBe('ansible-playbook site.yml\n');
  });

  it('parks the command and delivers it when the PTY spawn resolves', async () => {
    // Make the spawn hang so we can queue BEFORE ptyTabId is set — this is the
    // run-in-terminal race: the command arrives while the PTY is still spawning.
    let resolveSpawn!: (id: string) => void;
    ptySpawn.mockImplementationOnce(
      () => new Promise<string>((res) => { resolveSpawn = res; }),
    );

    reg.getOrCreate('t2', OPTS);
    reg.runWhenReady('t2', 'terraform plan');
    // Nothing written yet — PTY isn't live.
    expect(ptyWrite).not.toHaveBeenCalled();

    resolveSpawn('pty-2');
    await Promise.resolve();
    await Promise.resolve();

    const call = ptyWrite.mock.calls.find((c) => c[0] === 'pty-2');
    expect(call).toBeDefined();
    expect(writtenText(call!)).toBe('terraform plan\n');
  });
});

describe('session restore (replay scrollback)', () => {
  it('replays scrollback bytes into xterm before live output', () => {
    const e = reg.getOrCreate('t-replay', {
      ...OPTS,
      replayBytes: Array.from(new TextEncoder().encode('prev output')),
    });
    const written = (e.xterm.write as any).mock.calls.map((c: any[]) => c[0]);
    // First write is the replay bytes; a separator write follows.
    const decoded = written.map((w: any) =>
      typeof w === 'string' ? w : new TextDecoder().decode(new Uint8Array(w)),
    );
    expect(decoded.some((d: string) => d.includes('prev output'))).toBe(true);
    expect(decoded.some((d: string) => d.includes('session restored'))).toBe(true);
  });
});
