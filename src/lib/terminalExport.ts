import { terminalExportScrollback } from './tauri';

export type TerminalExportResult = 'exported' | 'cancelled' | 'failed';

function safeFilenamePart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_');
}

export async function chooseAndExportTerminalScrollback(
  tabId: string,
): Promise<TerminalExportResult> {
  const { message, save } = await import('@tauri-apps/plugin-dialog');
  const targetPath = await save({
    defaultPath: `terminal-scrollback-${safeFilenamePart(tabId)}.txt`,
    filters: [{ name: 'Text', extensions: ['txt'] }],
  });
  if (!targetPath) return 'cancelled';

  try {
    await terminalExportScrollback(tabId, targetPath as string);
    return 'exported';
  } catch (error) {
    await message(`Unable to export terminal scrollback: ${String(error)}`, {
      title: 'Scrollback export failed',
      kind: 'error',
    });
    return 'failed';
  }
}
