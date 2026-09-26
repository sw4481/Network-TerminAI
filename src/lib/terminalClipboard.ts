import { ask } from '@tauri-apps/plugin-dialog';
import { isTauri } from './tauriCheck';

export type TerminalPlatform = 'macos' | 'windows' | 'linux';
export type TerminalClipboardAction = 'copy' | 'paste' | 'pass-through' | 'swallow';
export type PasteResult = 'written' | 'empty' | 'cancelled';

type ShortcutEvent = Pick<
  KeyboardEvent,
  'type' | 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'preventDefault'
>;

type ClipboardDependencies = {
  readText: () => Promise<string>;
  writeText: (text: string) => Promise<void>;
  confirmMultiline: (message: string) => Promise<boolean>;
};

const defaultDependencies: ClipboardDependencies = {
  readText: async () => {
    if (isTauri()) {
      const { readText } = await import('@tauri-apps/plugin-clipboard-manager');
      return readText();
    }
    return navigator.clipboard.readText();
  },
  writeText: async (text) => {
    if (isTauri()) {
      const { writeText } = await import('@tauri-apps/plugin-clipboard-manager');
      await writeText(text);
      return;
    }
    await navigator.clipboard.writeText(text);
  },
  confirmMultiline: (message) => ask(message, {
    title: 'Confirm multiline paste',
    kind: 'warning',
    okLabel: 'Paste',
    cancelLabel: 'Cancel',
  }),
};

export function normalizeTerminalPlatform(
  platform = typeof navigator === 'undefined' ? '' : navigator.platform,
): TerminalPlatform {
  const normalized = platform.toUpperCase();
  if (normalized.includes('MAC')) return 'macos';
  if (normalized.includes('WIN')) return 'windows';
  return 'linux';
}

export function classifyTerminalClipboardShortcut(
  event: Pick<ShortcutEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
  platform: TerminalPlatform,
  hasSelection: boolean,
): TerminalClipboardAction {
  const key = event.key.toLowerCase();
  if ((key !== 'c' && key !== 'v') || event.altKey) return 'pass-through';

  if (platform === 'macos') {
    if (!event.metaKey || event.ctrlKey || event.shiftKey) return 'pass-through';
    if (key === 'v') return 'paste';
    return hasSelection ? 'copy' : 'swallow';
  }

  if (!event.ctrlKey || event.metaKey) return 'pass-through';
  if (platform === 'windows' && event.shiftKey) return 'pass-through';
  if (key === 'v') return 'paste';
  return hasSelection ? 'copy' : 'pass-through';
}

export function pasteCounts(text: string): { lines: number; characters: number } {
  let delimiters = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\r') {
      delimiters += 1;
      if (text[index + 1] === '\n') index += 1;
    } else if (text[index] === '\n') {
      delimiters += 1;
    }
  }
  return {
    lines: delimiters + 1,
    characters: Array.from(text).length,
  };
}

export async function copyTerminalSelection(
  selection: string,
  dependencies: Partial<ClipboardDependencies> = {},
): Promise<void> {
  if (!selection) return;
  await (dependencies.writeText ?? defaultDependencies.writeText)(selection);
}

export async function pasteClipboardToTerminal(
  write: (text: string) => Promise<void>,
  dependencies: Partial<ClipboardDependencies> = {},
): Promise<PasteResult> {
  const readText = dependencies.readText ?? defaultDependencies.readText;
  const confirmMultiline = dependencies.confirmMultiline ?? defaultDependencies.confirmMultiline;
  const text = await readText();
  if (!text) return 'empty';

  if (text.includes('\r') || text.includes('\n')) {
    const { lines, characters } = pasteCounts(text);
    const approved = await confirmMultiline(
      `Paste ${lines} lines (${characters} characters) into this terminal?`,
    );
    if (!approved) return 'cancelled';
  }

  await write(text);
  return 'written';
}

/**
 * Synchronous xterm custom-key adapter. Async clipboard work is launched only
 * after the pure policy classifies the chord; the return value follows xterm's
 * contract (`false` means handled/swallowed, `true` reaches onData).
 */
export function handleTerminalClipboardShortcut(
  event: ShortcutEvent,
  options: {
    platform: TerminalPlatform;
    selection: string;
    write: (text: string) => Promise<void>;
    onError?: (error: unknown) => void;
  },
): boolean {
  if (event.type !== 'keydown') return true;
  const action = classifyTerminalClipboardShortcut(
    event,
    options.platform,
    options.selection.length > 0,
  );
  if (action === 'pass-through') return true;

  event.preventDefault();
  const onError = options.onError ?? ((error: unknown) => console.error(error));
  if (action === 'copy') {
    void copyTerminalSelection(options.selection).catch(onError);
  } else if (action === 'paste') {
    void pasteClipboardToTerminal(options.write).catch(onError);
  }
  return false;
}
