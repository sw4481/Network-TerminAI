import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import SettingsBrowserTab from './SettingsBrowserTab';
import * as browserLib from '../lib/browser';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke } from '@tauri-apps/api/core';

describe('SettingsBrowserTab', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Mock the MCP config call
    (invoke as unknown as Mock).mockResolvedValue({
      command: '/path/to/mcp-server',
      args: ['--port', '3000'],
    });
  });

  it('lists open browser windows', async () => {
    vi.spyOn(browserLib, 'listBrowserWindows').mockResolvedValue([
      { browserId: 'browser-1', url: 'https://192.168.1.1' },
    ]);
    render(<SettingsBrowserTab />);
    await waitFor(() => {
      expect(screen.getByText(/192.168.1.1/)).toBeInTheDocument();
    });
  });

  it('shows hint when no browser windows are open', async () => {
    vi.spyOn(browserLib, 'listBrowserWindows').mockResolvedValue([]);
    render(<SettingsBrowserTab />);
    await waitFor(() => {
      expect(screen.getByText(/No open browser windows/i)).toBeInTheDocument();
    });
  });

  it('imports cookies from Chrome and shows the count', async () => {
    vi.spyOn(browserLib, 'listBrowserWindows').mockResolvedValue([
      { browserId: 'browser-1', url: 'https://192.168.1.1' },
    ]);
    const importSpy = vi.spyOn(browserLib, 'browserImportCookies').mockResolvedValue(5);

    render(<SettingsBrowserTab />);
    await waitFor(() => screen.getByText(/192.168.1.1/));

    fireEvent.click(screen.getByTestId('import-chrome-browser-1'));

    await waitFor(() => {
      expect(importSpy).toHaveBeenCalledWith('browser-1', 'chrome');
      expect(screen.getByText(/Imported 5 cookies from chrome/i)).toBeInTheDocument();
    });
  });

  it('imports cookies from Safari and shows the count', async () => {
    vi.spyOn(browserLib, 'listBrowserWindows').mockResolvedValue([
      { browserId: 'browser-2', url: 'https://switch.local' },
    ]);
    const importSpy = vi.spyOn(browserLib, 'browserImportCookies').mockResolvedValue(12);

    render(<SettingsBrowserTab />);
    await waitFor(() => screen.getByText(/switch.local/));

    fireEvent.click(screen.getByTestId('import-safari-browser-2'));

    await waitFor(() => {
      expect(importSpy).toHaveBeenCalledWith('browser-2', 'safari');
      expect(screen.getByText(/Imported 12 cookies from safari/i)).toBeInTheDocument();
    });
  });

  it('shows error message when import fails', async () => {
    vi.spyOn(browserLib, 'listBrowserWindows').mockResolvedValue([
      { browserId: 'browser-3', url: 'https://example.com' },
    ]);
    vi.spyOn(browserLib, 'browserImportCookies').mockRejectedValue(new Error('Keychain access denied'));

    render(<SettingsBrowserTab />);
    await waitFor(() => screen.getByText(/example.com/));

    fireEvent.click(screen.getByTestId('import-chrome-browser-3'));

    await waitFor(() => {
      expect(screen.getByText(/Import failed.*Keychain access denied/i)).toBeInTheDocument();
    });
  });

  it('renders MCP config section alongside cookie import section', async () => {
    vi.spyOn(browserLib, 'listBrowserWindows').mockResolvedValue([]);
    render(<SettingsBrowserTab />);

    await waitFor(() => {
      expect(screen.getByText('Browser Control MCP')).toBeInTheDocument();
      expect(screen.getByText('Cookie Import (macOS)')).toBeInTheDocument();
    });
  });
});
