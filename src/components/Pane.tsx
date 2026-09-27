import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from './Terminal';
import { RunStructuredModal } from './RunStructuredModal';
import { PaneActivityIndicator } from './PaneActivityIndicator';
import AgentActivityBadge from './AgentActivityBadge';
import { usePanesStore, shouldReconcileTerminalId } from '../state/panesStore';
import { ptyKill, ptyWrite } from '../lib/tauri';
import { ENABLE_TERMINAL_REGISTRY } from '../hooks/usePty';
import * as terminalRegistry from '../lib/terminalRegistry';
import { useBlockShortcuts } from '../hooks/useBlockShortcuts';
import { BlockList } from './BlockList';
import { InputEditor } from './InputEditor';
import { BlockSearch } from './BlockSearch';
import { useBlocksStore, type Block } from '../state/blocksStore';
import { useAgentsStore } from '../state/agentsStore';
import { useTopologyStore } from '../state/topologyStore';
import { TOPOLOGY_TRIGGER_CMD_RE } from '../lib/topology';
import { useTerminalBufferSearch } from '../hooks/useTerminalBufferSearch';
import { useTerminalConnectionStore } from '../state/terminalConnectionStore';
import { isTerminalSearchShortcut } from '../lib/terminalSearch';
import {
  copyTerminalSelection,
  pasteClipboardToTerminal,
} from '../lib/terminalClipboard';
import { chooseAndExportTerminalScrollback } from '../lib/terminalExport';
import { reconnectSavedSsh, useLocalShell } from '../lib/sshReconnect';
import './Pane.css';

type PaneProps = {
  paneId: string;
  terminalId: string;
  shell: string;
  cwd: string;
  canClose?: boolean;
};

type ContextMenuState = {
  x: number;
  y: number;
  selection: string;
};

const EMPTY_BLOCKS: Block[] = [];

export const Pane = memo(function Pane({ paneId, terminalId, shell, cwd, canClose = false }: PaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const focusedPaneId = usePanesStore((s) => s.focusedPaneId);
  const setFocusedPane = usePanesStore((s) => s.setFocusedPane);
  const updatePaneTerminalId = usePanesStore((s) => s.updatePaneTerminalId);
  const closePane = usePanesStore((s) => s.closePane);
  const terminalConnection = useTerminalConnectionStore((s) => s.byTerminalId[terminalId] ?? null);

  // Blocks mode: per-pane toggle between the raw terminal and the structured
  // command-block list. Lives here (not in TerminalSlot) so toggling it can
  // never change Terminal's key/props and re-trigger the registry's mount
  // effect — see docs/superpowers/specs/2026-07-02-restore-blocks-mode-and-view-menu-design.md.
  const [blocksMode, setBlocksMode] = useState(false);

  // Local-only mirror of the backend PTY id, for UI plumbing (BlockList,
  // useBlockShortcuts, InputEditor's ptyWrite target). This is SEPARATE from
  // the pane's real `terminalId` prop and must never feed into
  // updatePaneTerminalId — that reconciliation path is guarded off under
  // ENABLE_TERMINAL_REGISTRY specifically to prevent the 2026-06-23 infinite
  // PTY-respawn bug (see handleTerminalRegistered below).
  const [resolvedPtyTabId, setResolvedPtyTabId] = useState<string | null>(null);
  const terminalSearch = useTerminalBufferSearch(
    terminalRegistry.searchHandleFor(terminalId),
  );

  const { focusedBlockId, setFocusedBlockId } = useBlockShortcuts({
    tabId: resolvedPtyTabId,
    enabled: blocksMode && !!resolvedPtyTabId,
  });

  const blocks = useBlocksStore((s) =>
    resolvedPtyTabId ? s.blocksByTab.get(resolvedPtyTabId) ?? EMPTY_BLOCKS : EMPTY_BLOCKS,
  );
  const loadBlocksForTab = useBlocksStore((s) => s.loadBlocksForTab);

  const handleSetBlocksMode = (enabled: boolean) => {
    setBlocksMode(enabled);
    if (enabled && resolvedPtyTabId) {
      loadBlocksForTab(resolvedPtyTabId);
    }
  };

  const handleExecuteCommand = (command: string) => {
    if (!resolvedPtyTabId) return;
    const bytes = new TextEncoder().encode(command + '\n');
    ptyWrite(resolvedPtyTabId, bytes).catch(console.error);
  };

  const isFocused = focusedPaneId === paneId;

  // Auto-focus if no other pane is focused
  useEffect(() => {
    if (!focusedPaneId) {
      setFocusedPane(paneId);
    }
  }, [focusedPaneId, paneId, setFocusedPane]);

  // Focus the pane's xterm textarea. Works for BOTH terminal paths: the
  // registry path renders a `.terminal-slot` whose xterm creates a
  // `.xterm-helper-textarea`; the legacy path wraps xterm in `.xterm-container`.
  // Querying the textarea directly (it's what xterm focuses) covers both.
  const focusPaneTextarea = () => {
    const textarea =
      (containerRef.current?.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null) ??
      (containerRef.current?.querySelector('.xterm textarea') as HTMLTextAreaElement | null) ??
      (containerRef.current?.querySelector('.xterm-container textarea') as HTMLTextAreaElement | null);
    textarea?.focus();
  };

  // Focus xterm when this pane becomes focused
  useEffect(() => {
    if (isFocused) {
      // Small delay to ensure xterm is mounted
      const timer = setTimeout(focusPaneTextarea, 100);
      return () => clearTimeout(timer);
    }
  }, [isFocused, paneId]);

  // Search belongs to the focused terminal surface, not the browser/WebView.
  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (!isFocused || blocksMode || !isTerminalSearchShortcut(event)) return;
      const target = event.target as Node | null;
      const terminalSurface = containerRef.current?.querySelector('.terminal-registry-surface');
      if (!target || !terminalSurface?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      terminalSearch.openSearch();
    };
    window.addEventListener('keydown', handleSearchShortcut, true);
    return () => window.removeEventListener('keydown', handleSearchShortcut, true);
  }, [blocksMode, isFocused, terminalSearch.openSearch]);

  const handleClick = () => {
    setFocusedPane(paneId);
    // setTimeout to ensure xterm is rendered before focusing.
    setTimeout(focusPaneTextarea, 0);
  };

  const handleReconnect = useCallback(() => {
    void reconnectSavedSsh(terminalId);
  }, [terminalId]);

  const handleUseLocalShell = useCallback(() => {
    useLocalShell(terminalId);
    setTimeout(focusPaneTextarea, 0);
  }, [terminalId]);

  // While a saved SSH command is disconnected, an unmodified Enter on the
  // focused xterm means the same thing as the Reconnect button. Capture it at
  // the DOM boundary so it never leaks through to the local shell.
  useEffect(() => {
    const handleDisconnectedEnter = (event: KeyboardEvent) => {
      if (
        !isFocused ||
        blocksMode ||
        terminalSearch.open ||
        terminalConnection?.lifecycle !== 'disconnected' ||
        event.key !== 'Enter' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.isComposing
      ) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || !containerRef.current?.contains(target)) return;
      const isTerminalInput = target.matches('.xterm-helper-textarea') ||
        !!target.closest('.xterm, .terminal-registry-surface, .xterm-container');
      if (!isTerminalInput) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      handleReconnect();
    };
    window.addEventListener('keydown', handleDisconnectedEnter, true);
    return () => window.removeEventListener('keydown', handleDisconnectedEnter, true);
  }, [blocksMode, handleReconnect, isFocused, terminalConnection?.lifecycle, terminalSearch.open]);

  // useCallback: this is passed as Terminal's onRegistered prop, so a stable
  // identity keeps Terminal/TerminalSlot from re-rendering on every Pane
  // state change (blocksMode toggle, resolvedPtyTabId update, etc).
  const handleTerminalRegistered = useCallback((newTabId: string) => {
    // Local UI-only mirror — safe to set unconditionally, never touches the
    // pane's terminalId prop or panesStore.
    setResolvedPtyTabId(newTabId);
    // In registry mode, the terminalRegistry owns the terminalId→PTY mapping
    // (entry.ptyTabId) and is keyed by the STABLE pane terminalId. Mutating the
    // pane's terminalId here would change TerminalSlot's effect key, re-run it,
    // and spawn a fresh PTY every time — an infinite respawn loop (openpty
    // exhaustion). So only reconcile on the legacy usePty path.
    if (ENABLE_TERMINAL_REGISTRY) return;
    // Adopt the backend-spawned PTY id so the pane's terminalId is the real
    // PTY key. Root panes start as terminalId=tabId and split panes as
    // pending-*; both (and reloaded stale ids) must reconcile, else features
    // that resolve a PTY by pane (recording, pane-close kill) miss it.
    if (shouldReconcileTerminalId(terminalId, newTabId)) {
      updatePaneTerminalId(paneId, newTabId);
    }
  }, [terminalId, paneId, updatePaneTerminalId]);

  const handleClosePane = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (ENABLE_TERMINAL_REGISTRY) {
      terminalRegistry.dispose(terminalId);
    } else if (terminalId && !terminalId.startsWith('pending-')) {
      await ptyKill(terminalId).catch(() => {});
    }
    closePane(paneId);
  };

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [runStructuredOpen, setRunStructuredOpen] = useState(false);
  const [pendingStructuredCommand, setPendingStructuredCommand] = useState('');
  const agents = useAgentsStore((s) => s.agents);

  const contextMenuRef = useRef<HTMLDivElement | null>(null);

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const selection = terminalRegistry.getSelection(terminalId);

    // Clamp the menu into the viewport so it's never clipped near the bottom
    // or right edge. Uses approximate dimensions here; a post-render effect
    // fine-tunes with the menu's real measured size.
    const menuWidth = 220;
    const menuHeight = 420;
    let x = e.clientX;
    let y = e.clientY;
    if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 8;
    if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 8;
    x = Math.max(8, x);
    y = Math.max(8, y);

    // Always show the context menu, even without a selection (for paste).
    setContextMenu({ x, y, selection: selection || '' });
  };

  const handleAskAI = () => {
    if (!contextMenu) return;
    window.dispatchEvent(
      new CustomEvent('ccie:ask-ai-about-selection', {
        detail: { selection: contextMenu.selection },
      }),
    );
    setContextMenu(null);
  };

  const handleAskAgent = (agentId: string) => {
    if (!contextMenu) return;
    window.dispatchEvent(
      new CustomEvent('ccie:invoke-agent', {
        detail: {
          agentId,
          selection: contextMenu.selection,
          message: 'Explain this terminal output and suggest next steps.',
          autoSend: false,
        },
      }),
    );
    setContextMenu(null);
  };

  const handleTroubleshootWithArchitect = () => {
    if (!contextMenu) return;
    setFocusedPane(paneId);
    window.dispatchEvent(
      new CustomEvent('ccie:invoke-agent', {
        detail: {
          agentId: 'network-architect',
          message: 'Troubleshoot this terminal session.',
          autoSend: false,
          attachTerminal: true,
        },
      }),
    );
    setContextMenu(null);
  };

  const handleCopy = async () => {
    if (!contextMenu) return;
    const selection = contextMenu.selection;
    setContextMenu(null);
    try {
      await copyTerminalSelection(selection);
    } catch (err) {
      console.error('[Pane] clipboard copy failed:', err);
    }
  };

  const handlePaste = async () => {
    if (!resolvedPtyTabId) return;
    const ptyTabId = resolvedPtyTabId;
    setContextMenu(null);
    try {
      await pasteClipboardToTerminal((text) =>
        ptyWrite(ptyTabId, new TextEncoder().encode(text)),
      );
    } catch (err) {
      console.error('[Pane] clipboard paste failed:', err);
    }
  };

  const handleExportScrollback = async () => {
    const ptyTabId = resolvedPtyTabId;
    setContextMenu(null);
    if (!ptyTabId) return;
    await chooseAndExportTerminalScrollback(ptyTabId);
  };

  const handleIngestTopology = async () => {
    if (!contextMenu) return;
    const selection = contextMenu.selection.trim();
    if (!selection) return;

    const lines = selection.split('\n');
    let command = '';
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      const line = lines[i].trim();
      const cleaned = line.replace(/^[^\s#$>]+[#$>]\s*/, '');
      if (TOPOLOGY_TRIGGER_CMD_RE.test(cleaned)) {
        command = cleaned;
        break;
      }
    }

    if (!command) {
      console.error('[Pane] No topology command found in selection');
      setContextMenu(null);
      return;
    }

    const vendor = 'cisco';
    const platform = 'iosxe';
    const deviceRef = 'unknown-device';
    const deviceKind = 'ssh';

    setContextMenu(null);

    try {
      await useTopologyStore.getState().ingestFromText(
        command,
        selection,
        vendor,
        platform,
        deviceRef,
        deviceKind,
      );
    } catch (err) {
      console.error('[Pane] Topology ingestion failed:', err);
    }
  };

  const handleOpenRunStructured = () => {
    const firstLine = (contextMenu?.selection ?? '').split('\n')[0]?.trim() ?? '';
    setPendingStructuredCommand(firstLine);
    setRunStructuredOpen(true);
    setContextMenu(null);
  };

  // Close context menu on any click outside it.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [contextMenu]);

  // After the menu renders, re-clamp using its real measured size so the full
  // list is visible (the pre-render estimate can be off for tall menus).
  useEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;
    const rect = contextMenuRef.current.getBoundingClientRect();
    let x = contextMenu.x;
    let y = contextMenu.y;
    let needsAdjust = false;
    if (rect.right > window.innerWidth) {
      x = Math.max(8, window.innerWidth - rect.width - 8);
      needsAdjust = true;
    }
    if (rect.bottom > window.innerHeight) {
      y = Math.max(8, window.innerHeight - rect.height - 8);
      needsAdjust = true;
    }
    if (needsAdjust) setContextMenu((prev) => (prev ? { ...prev, x, y } : prev));
    // Only re-run when the menu's position/selection changes, not on every render.
  }, [contextMenu?.x, contextMenu?.y, contextMenu?.selection]);

  const menuButtonStyle: React.CSSProperties = {
    display: 'block',
    width: '100%',
    textAlign: 'left',
    padding: '8px 12px',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    borderRadius: '4px',
    fontSize: '13px',
  };

  return (
    <div
      ref={containerRef}
      className={`pane ${isFocused ? 'pane-focused' : ''}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      data-pane-id={paneId}
      data-accent={terminalConnection?.accent_color ?? undefined}
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}
    >
      {/* Activity indicators key off terminalId, not the layout paneId: the
          backend emits pane_activity_updated keyed by the PTY/tab id (see
          pty_spawn register_pane), which is the pane's terminalId. Passing
          paneId here never matched, so indicators silently rendered nothing. */}
      <PaneActivityIndicator paneId={terminalId} />
      <AgentActivityBadge paneId={terminalId} />

      {canClose && (
        <button
          className="pane-close"
          onClick={handleClosePane}
          title="Close pane (⌘W)"
          aria-label="Close pane"
          data-testid={`pane-close-${paneId}`}
        >
          ×
        </button>
      )}

      <div className="terminal-mode-toggle">
        <button
          className={`mode-btn ${!blocksMode ? 'active' : ''}`}
          onClick={() => handleSetBlocksMode(false)}
          title="Traditional terminal mode (for SSH, vim, etc.)"
        >
          Terminal
        </button>
        <button
          className={`mode-btn ${blocksMode ? 'active' : ''}`}
          onClick={() => handleSetBlocksMode(true)}
          title="Blocks mode (for simple commands)"
        >
          Blocks
        </button>
        {terminalConnection && (
          <span className="connected-device-chip" title={`${terminalConnection.vendor}/${terminalConnection.platform}`}>
            <span className="connected-device-chip__accent" aria-hidden="true" />
            {terminalConnection.display_name}
          </span>
        )}
      </div>

      {terminalSearch.open && !blocksMode && (
        <BlockSearch
          searchQuery={terminalSearch.query}
          onSearchChange={terminalSearch.setQuery}
          matchCount={terminalSearch.resultCount}
          currentMatch={terminalSearch.resultIndex}
          onNext={terminalSearch.next}
          onPrev={terminalSearch.previous}
          onClose={terminalSearch.closeSearch}
          inputLabel="Search terminal scrollback"
          placeholder="Search terminal scrollback…"
        />
      )}

      {terminalConnection && ['disconnected', 'reconnecting', 'error'].includes(terminalConnection.lifecycle) && !blocksMode && (
        <div className="ssh-reconnect-banner" role="status">
          <div className="ssh-reconnect-banner__message">
            <strong>{terminalConnection.display_name}</strong>
            {terminalConnection.lifecycle === 'reconnecting'
              ? ' — reconnecting…'
              : terminalConnection.lifecycle === 'error'
                ? ` — ${terminalConnection.error ?? 'Reconnect failed.'}`
                : ` — disconnected${terminalConnection.exit_status == null ? '' : ` (exit ${terminalConnection.exit_status})`}`}
          </div>
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); handleReconnect(); }}
            disabled={terminalConnection.lifecycle === 'reconnecting'}
          >
            {terminalConnection.lifecycle === 'reconnecting' ? 'Reconnecting…' : 'Reconnect'}
          </button>
          <button
            type="button"
            onClick={(event) => { event.stopPropagation(); handleUseLocalShell(); }}
          >
            Use local shell
          </button>
        </div>
      )}

      {/* Terminal stays mounted unconditionally — blocksMode only hides it
          via CSS, exactly the technique LegacyTerminal used, and for the same
          reason: toggling must never remount/re-key TerminalSlot's registry
          session. */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          visibility: blocksMode ? 'hidden' : 'visible',
          position: blocksMode ? 'absolute' : 'relative',
          inset: blocksMode ? 0 : undefined,
          zIndex: blocksMode ? -1 : undefined,
        }}
      >
        <Terminal
          terminalId={terminalId}
          shell={shell}
          cwd={cwd}
          onRegistered={handleTerminalRegistered}
          skipTabRegistration={true}
        />
      </div>

      {blocksMode && (
        <div className="blocks-overlay">
          {resolvedPtyTabId ? (
            <BlockList
              tabId={resolvedPtyTabId}
              blocks={blocks}
              focusedBlockId={focusedBlockId}
              onFocusBlock={setFocusedBlockId}
            />
          ) : (
            <div className="blocks-history">
              <div className="blocks-empty-state">
                <p>Blocks Mode - Command History</p>
                <p className="hint">Connecting…</p>
              </div>
            </div>
          )}
          <InputEditor
            prompt="$ "
            onExecute={handleExecuteCommand}
            disabled={!resolvedPtyTabId}
          />
        </div>
      )}

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="terminal-context-menu"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
            background: 'var(--surface-2)',
            border: '1px solid var(--border-default)',
            borderRadius: '6px',
            boxShadow: '0 4px 12px rgb(var(--backdrop-rgb) / 0.5)',
            padding: '4px',
            zIndex: 10000,
            minWidth: '200px',
            maxHeight: '420px',
            overflowY: 'auto',
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Copy / Paste pinned to the top for quick access. */}
          {contextMenu.selection && contextMenu.selection.trim() && (
            <button
              onClick={handleCopy}
              style={menuButtonStyle}
              onMouseOver={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            >
              📋 Copy
            </button>
          )}
          <button
            onClick={handlePaste}
            style={menuButtonStyle}
            onMouseOver={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            📄 Paste
          </button>
          <button
            onClick={() => void handleExportScrollback()}
            disabled={!resolvedPtyTabId}
            style={{
              ...menuButtonStyle,
              opacity: resolvedPtyTabId ? 1 : 0.5,
              cursor: resolvedPtyTabId ? 'pointer' : 'not-allowed',
            }}
            onMouseOver={(e) => {
              if (resolvedPtyTabId) e.currentTarget.style.background = 'var(--surface-3)';
            }}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
          >
            🧾 Export redacted scrollback…
          </button>
          <div style={{ borderTop: '1px solid var(--border-default)', margin: '4px 0' }} />
          <button
            onClick={handleTroubleshootWithArchitect}
            style={menuButtonStyle}
            onMouseOver={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
            onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
            title="Attach this terminal to one Network Architect turn"
          >
            🩺 Troubleshoot with Network Architect
          </button>
          <div style={{ borderTop: '1px solid var(--border-default)', margin: '4px 0' }} />
          {contextMenu.selection && contextMenu.selection.trim() && (
            <>
              <button
                onClick={handleAskAI}
                style={menuButtonStyle}
                onMouseOver={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
                onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
              >
                ✨ Ask AI about selection
              </button>
              {agents.length > 0 && (
                <div style={{ borderTop: '1px solid var(--border-default)', margin: '4px 0', paddingTop: '4px' }}>
                  <div
                    style={{
                      padding: '4px 12px',
                      color: 'var(--text-muted)',
                      fontSize: '11px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.06em',
                    }}
                  >
                    Ask agent
                  </div>
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => handleAskAgent(a.id)}
                      style={menuButtonStyle}
                      onMouseOver={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
                      onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                      title={a.description}
                    >
                      🤖 {a.name}
                    </button>
                  ))}
                </div>
              )}
              {contextMenu.selection.split('\n').slice(0, 5).some((line) => {
                const cleaned = line.replace(/^[^\s#$>]+[#$>]\s*/, '').trim();
                return TOPOLOGY_TRIGGER_CMD_RE.test(cleaned);
              }) && (
                <>
                  <div style={{ borderTop: '1px solid var(--border-default)', margin: '4px 0' }} />
                  <button
                    onClick={handleIngestTopology}
                    style={menuButtonStyle}
                    onMouseOver={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
                    onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
                    title="Parse and add neighbors to topology graph"
                  >
                    🗺️ Ingest Topology
                  </button>
                </>
              )}
              <div style={{ borderTop: '1px solid var(--border-default)', margin: '4px 0' }} />
            </>
          )}
          <div style={{ paddingTop: contextMenu.selection && contextMenu.selection.trim() ? '4px' : '0' }}>
            <button
              onClick={handleOpenRunStructured}
              style={menuButtonStyle}
              onMouseOver={(e) => (e.currentTarget.style.background = 'var(--surface-3)')}
              onMouseOut={(e) => (e.currentTarget.style.background = 'transparent')}
              title="Run this command over SSH and view it as structured/diffable data"
            >
              🧩 Run as Structured...
            </button>
          </div>
        </div>
      )}

      {runStructuredOpen && (
        <RunStructuredModal
          tabId={resolvedPtyTabId ?? terminalId}
          initialCommand={pendingStructuredCommand}
          onClose={() => setRunStructuredOpen(false)}
        />
      )}
    </div>
  );
});
