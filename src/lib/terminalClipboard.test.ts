import { describe, expect, it, vi } from 'vitest';

const nativeClipboard = vi.hoisted(() => ({
  readText: vi.fn<() => Promise<string>>(),
  writeText: vi.fn<(text: string) => Promise<void>>(),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: nativeClipboard.readText,
  writeText: nativeClipboard.writeText,
}));

import {
  classifyTerminalClipboardShortcut,
  copyTerminalSelection,
  normalizeTerminalPlatform,
  pasteClipboardToTerminal,
  pasteCounts,
  type TerminalPlatform,
} from './terminalClipboard';

const event = (
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>> = {},
) => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
});

describe('terminal clipboard shortcut policy', () => {
  it('normalizes browser platform strings', () => {
    expect(normalizeTerminalPlatform('MacIntel')).toBe('macos');
    expect(normalizeTerminalPlatform('Win32')).toBe('windows');
    expect(normalizeTerminalPlatform('Linux x86_64')).toBe('linux');
  });

  const cases: Array<{
    label: string;
    platform: TerminalPlatform;
    chord: ReturnType<typeof event>;
    selected: boolean;
    expected: string;
  }> = [
    { label: 'mac Cmd+C selection', platform: 'macos', chord: event('c', { metaKey: true }), selected: true, expected: 'copy' },
    { label: 'mac uppercase Cmd+C', platform: 'macos', chord: event('C', { metaKey: true }), selected: true, expected: 'copy' },
    { label: 'mac Cmd+C no selection', platform: 'macos', chord: event('c', { metaKey: true }), selected: false, expected: 'swallow' },
    { label: 'mac Cmd+V', platform: 'macos', chord: event('v', { metaKey: true }), selected: false, expected: 'paste' },
    { label: 'mac Ctrl+C stays PTY input', platform: 'macos', chord: event('c', { ctrlKey: true }), selected: false, expected: 'pass-through' },
    { label: 'mac shifted Cmd chord ignored', platform: 'macos', chord: event('c', { metaKey: true, shiftKey: true }), selected: true, expected: 'pass-through' },
    { label: 'windows Ctrl+C selection', platform: 'windows', chord: event('c', { ctrlKey: true }), selected: true, expected: 'copy' },
    { label: 'windows Ctrl+C no selection', platform: 'windows', chord: event('c', { ctrlKey: true }), selected: false, expected: 'pass-through' },
    { label: 'windows Ctrl+V', platform: 'windows', chord: event('v', { ctrlKey: true }), selected: false, expected: 'paste' },
    { label: 'windows Ctrl+Shift ignored', platform: 'windows', chord: event('v', { ctrlKey: true, shiftKey: true }), selected: false, expected: 'pass-through' },
    { label: 'linux Ctrl+C selection', platform: 'linux', chord: event('c', { ctrlKey: true }), selected: true, expected: 'copy' },
    { label: 'linux Ctrl+Shift+C selection', platform: 'linux', chord: event('C', { ctrlKey: true, shiftKey: true }), selected: true, expected: 'copy' },
    { label: 'linux Ctrl+C no selection', platform: 'linux', chord: event('c', { ctrlKey: true }), selected: false, expected: 'pass-through' },
    { label: 'linux Ctrl+V', platform: 'linux', chord: event('v', { ctrlKey: true }), selected: false, expected: 'paste' },
    { label: 'linux Ctrl+Shift+V', platform: 'linux', chord: event('V', { ctrlKey: true, shiftKey: true }), selected: false, expected: 'paste' },
    { label: 'Alt excludes clipboard chords', platform: 'linux', chord: event('v', { ctrlKey: true, altKey: true }), selected: false, expected: 'pass-through' },
    { label: 'unexpected Meta excludes chord', platform: 'linux', chord: event('v', { ctrlKey: true, metaKey: true }), selected: false, expected: 'pass-through' },
  ];

  for (const testCase of cases) {
    it(testCase.label, () => {
      expect(classifyTerminalClipboardShortcut(
        testCase.chord,
        testCase.platform,
        testCase.selected,
      )).toBe(testCase.expected);
    });
  }
});

describe('terminal clipboard operations', () => {
  it('uses the native Tauri clipboard without invoking the WebView paste prompt', async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const webReadText = vi.fn(async () => 'wrong-web-value');
    const webWriteText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { readText: webReadText, writeText: webWriteText },
    });
    nativeClipboard.readText.mockResolvedValueOnce('native paste');
    nativeClipboard.writeText.mockResolvedValueOnce(undefined);
    const write = vi.fn(async () => undefined);

    try {
      await pasteClipboardToTerminal(write);
      await copyTerminalSelection('native copy');
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }

    expect(nativeClipboard.readText).toHaveBeenCalledTimes(1);
    expect(nativeClipboard.writeText).toHaveBeenCalledWith('native copy');
    expect(webReadText).not.toHaveBeenCalled();
    expect(webWriteText).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('native paste');
  });

  it('copies only non-empty selections', async () => {
    const writeText = vi.fn(async () => undefined);
    await copyTerminalSelection('', { writeText });
    await copyTerminalSelection('selected output', { writeText });
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('selected output');
  });

  it('writes a single-line paste immediately and unchanged', async () => {
    const write = vi.fn(async () => undefined);
    const confirmMultiline = vi.fn(async () => true);
    const result = await pasteClipboardToTerminal(write, {
      readText: vi.fn(async () => 'show version'),
      confirmMultiline,
    });
    expect(result).toBe('written');
    expect(confirmMultiline).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('show version');
  });

  it('counts CRLF once, lone CR/LF separately, and Unicode by code point', () => {
    expect(pasteCounts('one\r\ntwo\rthree\nfour😀')).toEqual({
      lines: 4,
      characters: 20,
    });
  });

  it('confirms multiline content with counts only, then writes original bytes', async () => {
    const text = 'show clock\r\nshow users😀';
    const write = vi.fn(async () => undefined);
    const confirmMultiline = vi.fn(async () => true);
    const result = await pasteClipboardToTerminal(write, {
      readText: vi.fn(async () => text),
      confirmMultiline,
    });
    expect(result).toBe('written');
    expect(confirmMultiline).toHaveBeenCalledWith('Paste 2 lines (23 characters) into this terminal?');
    expect(JSON.stringify(confirmMultiline.mock.calls)).not.toContain('show clock');
    expect(write).toHaveBeenCalledWith(text);
  });

  it('cancels multiline paste without a PTY write', async () => {
    const write = vi.fn(async () => undefined);
    const result = await pasteClipboardToTerminal(write, {
      readText: vi.fn(async () => 'one\ntwo'),
      confirmMultiline: vi.fn(async () => false),
    });
    expect(result).toBe('cancelled');
    expect(write).not.toHaveBeenCalled();
  });

  it('treats an empty clipboard as a handled no-op', async () => {
    const write = vi.fn(async () => undefined);
    expect(await pasteClipboardToTerminal(write, {
      readText: vi.fn(async () => ''),
    })).toBe('empty');
    expect(write).not.toHaveBeenCalled();
  });

  it('propagates confirmation and write failures', async () => {
    await expect(pasteClipboardToTerminal(vi.fn(), {
      readText: vi.fn(async () => 'one\ntwo'),
      confirmMultiline: vi.fn(async () => { throw new Error('dialog failed'); }),
    })).rejects.toThrow('dialog failed');

    await expect(pasteClipboardToTerminal(
      vi.fn(async () => { throw new Error('write failed'); }),
      { readText: vi.fn(async () => 'single') },
    )).rejects.toThrow('write failed');
  });
});
