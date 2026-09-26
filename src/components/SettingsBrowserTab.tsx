import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listBrowserWindows, browserImportCookies, BrowserWindowInfo } from '../lib/browser';
import './SettingsBrowserTab.css';

interface BrowserMcpConfig {
  command: string;
  args: string[];
}

const SettingsBrowserTab: React.FC = () => {
  const [config, setConfig] = useState<BrowserMcpConfig | null>(null);
  const [copied, setCopied] = useState(false);
  const [windows, setWindows] = useState<BrowserWindowInfo[]>([]);
  const [importStatus, setImportStatus] = useState<string>('');

  useEffect(() => {
    loadConfig();
    loadWindows();
  }, []);

  const loadConfig = async () => {
    try {
      const cfg = await invoke<BrowserMcpConfig>('get_browser_mcp_config');
      setConfig(cfg);
    } catch (error) {
      console.error('Failed to load browser MCP config:', error);
    }
  };

  const loadWindows = async () => {
    try {
      const wins = await listBrowserWindows();
      setWindows(wins);
    } catch (error) {
      console.error('Failed to list browser windows:', error);
    }
  };

  const handleImport = async (browserId: string, source: 'chrome' | 'safari') => {
    setImportStatus('Importing…');
    try {
      const count = await browserImportCookies(browserId, source);
      setImportStatus(`Imported ${count} cookies from ${source}.`);
    } catch (e) {
      setImportStatus(`Import failed: ${e}`);
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy to clipboard:', error);
    }
  };

  if (!config) {
    return <div>Loading...</div>;
  }

  const claudeCodeSnippet = `claude mcp add browser-control -- ${config.command} ${config.args.join(' ')}`;
  const codexConfig = JSON.stringify({
    command: config.command,
    args: config.args
  }, null, 2);

  return (
    <div className="browser-settings-tab">
      <h2>Browser Control MCP</h2>
      <p className="muted" style={{ marginBottom: '24px' }}>
        Configure external agents (Claude Code, Codex) to use browser-control tools.
        Built-in agents are already configured automatically.
      </p>

      <div className="settings-group">
        <h3>Claude Code</h3>
        <p className="muted" style={{ marginBottom: '12px' }}>
          Run this command to register browser-control with Claude Code:
        </p>
        <div className="code-block">
          <code>{claudeCodeSnippet}</code>
        </div>
        <button
          type="button"
          onClick={() => handleCopy(claudeCodeSnippet)}
          className="copy-button"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>

      <div className="settings-group">
        <h3>Codex / Other Clients</h3>
        <p className="muted" style={{ marginBottom: '12px' }}>
          Use this configuration for MCP clients that accept JSON:
        </p>
        <div className="code-block">
          <pre>{codexConfig}</pre>
        </div>
        <button
          type="button"
          onClick={() => handleCopy(codexConfig)}
          className="copy-button"
        >
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>

      <div className="settings-group">
        <h3>Cookie Import (macOS)</h3>
        <p className="muted" style={{ marginBottom: '12px' }}>
          Import cookies from Chrome or Safari into an open browser window so device
          web UIs are pre-authenticated. Cookies are scoped to the window's current host.
        </p>
        {windows.length === 0 ? (
          <div className="muted" style={{ padding: '12px 0' }}>
            No open browser windows. Open one from Operate → Browser.
          </div>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {windows.map((w) => (
              <li key={w.browserId} style={{ marginBottom: '12px', padding: '12px', background: 'var(--border-default)', border: '1px solid var(--border-default)', borderRadius: '4px' }}>
                <div style={{ fontFamily: 'monospace', fontSize: 13, marginBottom: '8px', color: 'var(--text-primary)' }}>{w.url}</div>
                <button
                  data-testid={`import-chrome-${w.browserId}`}
                  onClick={() => handleImport(w.browserId, 'chrome')}
                  className="copy-button"
                  style={{ marginRight: '8px' }}
                >
                  Import from Chrome
                </button>
                <button
                  data-testid={`import-safari-${w.browserId}`}
                  onClick={() => handleImport(w.browserId, 'safari')}
                  className="copy-button"
                >
                  Import from Safari
                </button>
              </li>
            ))}
          </ul>
        )}
        {importStatus && <div style={{ marginTop: '12px', color: 'var(--text-primary)', fontSize: 13 }}>{importStatus}</div>}
      </div>
    </div>
  );
};

export default SettingsBrowserTab;
