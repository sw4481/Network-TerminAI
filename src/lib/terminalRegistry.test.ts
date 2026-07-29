import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock tauri PTY calls.
const ptySpawn = vi.fn(async (_arg?: any) => 'pty-1');
const ptyKill = vi.fn(async (_arg?: any) => {});
const ptyWrite = vi.fn(async (_id?: any, _bytes?: any) => {});
vi.mock('./tauri', () => ({
  ptySpawn: (arg?: any) => ptySpawn(arg),
  ptyKill: (arg?: any) => ptyKill(arg),
  ptyResize: vi.fn(async () => {}),
  ptyWrite: (id?: any, bytes?: any) => ptyWrite(id, bytes),
}));

/** Decode the bytes passed to a ptyWrite mock call back into a string. */
function writtenText(call: any[]): string {
  return new TextDecoder().decode(call[1]);
}

// Minimal fake xterm + addons on window (CDN shape).
function installFakeXterm() {
  const made: any[] = [];
  (window as any).Terminal = class {
    cols = 80; rows = 24;
    onData = vi.fn(() => ({ dispose: vi.fn() }));
    loadAddon = vi.fn();
    open = vi.fn();
    refresh = vi.fn();
    focus = vi.fn();
    dispose = vi.fn();
    write = vi.fn();
    attachCustomKeyEventHandler = vi.fn();
    getSelection = vi.fn(() => '');
    constructor() { made.push(this); }
  };
  (window as any).FitAddon = { FitAddon: class { fit = vi.fn(); } };
  (window as any).WebLinksAddon = { WebLinksAddon: class {} };
  (window as any).ClipboardAddon = { ClipboardAddon: class {} };
  return made;
}

import * as reg from './terminalRegistry';

beforeEach(() => {
  reg.__resetForTest();
  ptySpawn.mockClear();
  ptyKill.mockClear();
  ptyWrite.mockClear();
  installFakeXterm();
});

const OPTS = { shell: '/bin/zsh', cwd: '/home' };

describe('terminalRegistry lifecycle', () => {
  it('getOrCreate spawns one PTY and reuses the entry on second call', () => {
    const a = reg.getOrCreate('t1', OPTS);
    const b = reg.getOrCreate('t1', OPTS);
    expect(a).toBe(b);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
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
    expect(reg.has('t1')).toBe(false);
    reg.dispose('t1'); // no throw, no extra calls
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(ptyKill).toHaveBeenCalledTimes(1);
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

  it('exit event disposes the terminal', async () => {
    reg.getOrCreate('t1', OPTS);
    await Promise.resolve();
    const onEvent = ptySpawn.mock.calls[0][0].onEvent as (ev: any) => void;
    onEvent({ type: 'exit' });
    expect(reg.has('t1')).toBe(false);
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
