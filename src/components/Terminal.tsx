import { memo, useEffect, useRef, useState, MouseEvent, useCallback } from "react";
import { usePty, ENABLE_LOCAL_ECHO, ENABLE_TERMINAL_REGISTRY } from "../hooks/usePty";
import { useAgentsStore } from "../state/agentsStore";
import { useBlocksStore, type Block } from "../state/blocksStore";
import { useSshPasswordStore } from "../state/sshPasswordStore";
import { useTerminalConnectionStore } from "../state/terminalConnectionStore";
import { useTopologyStore } from "../state/topologyStore";
import { useTabs } from "../state/tabsStore";
import { usePanesStore } from "../state/panesStore";
import { useIacStateStore } from "../state/iacStateStore";
import { TOPOLOGY_TRIGGER_CMD_RE } from "../lib/topology";
import { BlockList } from "./BlockList";
import { InputEditor } from "./InputEditor";
import { CommandSuggestions } from "./CommandSuggestions";
import { ParameterForm } from "./ParameterForm";
import { NaturalLanguageInput } from "./NaturalLanguageInput";
import { CommandTemplates } from "./CommandTemplates";
import { TerminalSlot } from "./TerminalSlot";
import { BlockSearch } from "./BlockSearch";
import { useCommandSuggestions } from "../hooks/useCommandSuggestions";
import { useParameterDetection } from "../hooks/useParameterDetection";
import { useBlockShortcuts } from "../hooks/useBlockShortcuts";
import { ptyWrite, terminalLaunchSavedSsh } from "../lib/tauri";
import { useTerminalBufferSearch } from "../hooks/useTerminalBufferSearch";
import { isTerminalSearchShortcut } from "../lib/terminalSearch";
import {
  copyTerminalSelection,
  pasteClipboardToTerminal,
} from "../lib/terminalClipboard";
import { chooseAndExportTerminalScrollback } from "../lib/terminalExport";
import type { SshConnectEventDetail } from "../lib/sshConnections";

type TerminalProps = {
  shell: string;
  cwd: string;
  /** Fired once the PTY is spawned and we know which tab_id this Terminal owns. */
  onRegistered?: (tabId: string) => void;
  /** If true, don't add this terminal as a tab in the tab bar (used for split panes) */
  skipTabRegistration?: boolean;
  /** Terminal ID for persistent terminal registry */
  terminalId?: string;
  /** Attach to a PTY already owned by another Tauri webview. */
  attach?: boolean;
  /** Initial scrollback used when attaching to an existing PTY. */
  replayBytes?: number[];
};

type ContextMenuState = {
  x: number;
  y: number;
  selection: string;
};

const EMPTY_BLOCKS: Block[] = [];

const LegacyTerminal = memo(function LegacyTerminal({ shell, cwd, onRegistered, skipTabRegistration }: TerminalProps) {
  // Toggle between blocks mode and traditional terminal mode
  // Default to Terminal mode (false) since blocks don't support interactive commands
  const [blocksMode, setBlocksMode] = useState(false);

  // Single stable container for xterm - NEVER unmount this
  const [xtermContainer, setXtermContainer] = useState<HTMLDivElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const handle = usePty(xtermContainer, shell, cwd, skipTabRegistration);
  const terminalSearch = useTerminalBufferSearch(handle?.search ?? null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const agents = useAgentsStore((s) => s.agents);

  // Get active tab and focused pane for agent context
  const activeTabId = useTabs((s) => s.activeTabId);
  const focusedPaneId = usePanesStore((s) => s.focusedPaneId);

  // Command suggestion state
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [currentInput, setCurrentInput] = useState('');
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const { suggestions, loading, getSuggestions, clearSuggestions } = useCommandSuggestions(cwd);

  // Parameter detection and form state
  const { commandDef, shouldShow } = useParameterDetection(currentInput);
  const [showParameterForm, setShowParameterForm] = useState(false);

  // Natural language input state
  const [showNLInput, setShowNLInput] = useState(false);

  // Command templates state
  const [showTemplates, setShowTemplates] = useState(false);

  // Track current line buffer for input tracking
  const lineBufferRef = useRef<string>('');
  const currentTabIdRef = useRef<string | null>(null);
  const acceptingSuggestionRef = useRef<boolean>(false);
  const lastAcceptedCommandRef = useRef<string>('');
  const lastCommandRef = useRef<string>('');
  const passwordAutoFillRef = useRef<{ host: string; user: string | null; password: string } | null>(null);

  // Get blocks for this tab - use stable empty array reference
  const blocks = useBlocksStore((s) => {
    if (!handle?.tabId) return EMPTY_BLOCKS;
    return s.blocksByTab.get(handle.tabId) ?? EMPTY_BLOCKS;
  });
  const loadBlocks = useBlocksStore((s) => s.loadBlocksForTab);

  // Reload blocks when switching to blocks mode
  const handleSetBlocksMode = useCallback((enabled: boolean) => {
    setBlocksMode(enabled);
    if (enabled && handle?.tabId) {
      // Refresh blocks from database when switching to blocks view
      loadBlocks(handle.tabId);
    } else if (!enabled && handle) {
      // Switching back to terminal: the xterm was visibility:hidden, so it
      // may need a refit + focus once it's visible again. Defer to next frame
      // so layout has settled. Output is preserved (node was never unmounted).
      requestAnimationFrame(() => {
        handle.fit();
        handle.term?.focus?.();
      });
    }
  }, [handle, loadBlocks]);

  // Block keyboard shortcuts (⌘↑/↓ navigation, ⌘K B/P/T/S chords).
  // Active only while in blocks mode and the tab is registered.
  const { focusedBlockId, setFocusedBlockId } = useBlockShortcuts({
    tabId: handle?.tabId ?? null,
    enabled: blocksMode && !!handle?.tabId,
  });

  // Track whether we've loaded blocks for this tab to avoid infinite loops
  const loadedTabIdRef = useRef<string | null>(null);

  // Notify parent once we know our tab_id, so it can pair this mounted Terminal
  // with the corresponding tab in state (by id, not by array index).
  const registeredRef = useRef<string | null>(null);
  useEffect(() => {
    if (!handle) return;
    if (registeredRef.current === handle.tabId) return;
    registeredRef.current = handle.tabId;
    onRegistered?.(handle.tabId);

    // Load existing blocks for this tab (only once)
    if (loadedTabIdRef.current !== handle.tabId) {
      loadedTabIdRef.current = handle.tabId;
      loadBlocks(handle.tabId);
    }
  }, [handle, onRegistered, loadBlocks]);

  useEffect(() => {
    if (!handle || !wrapRef.current) return;
    const ro = new ResizeObserver(() => handle.fit());
    ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [handle]);

  useEffect(() => {
    const handleSearchShortcut = (event: KeyboardEvent) => {
      if (blocksMode || !isTerminalSearchShortcut(event)) return;
      const target = event.target as Node | null;
      const terminalSurface = wrapRef.current?.querySelector('.xterm-container');
      if (!target || !terminalSurface?.contains(target)) return;
      event.preventDefault();
      event.stopPropagation();
      terminalSearch.openSearch();
    };
    window.addEventListener('keydown', handleSearchShortcut, true);
    return () => window.removeEventListener('keydown', handleSearchShortcut, true);
  }, [blocksMode, terminalSearch.openSearch]);

  // Clear buffer when tab changes to prevent corruption
  useEffect(() => {
    if (!handle) return;
    if (currentTabIdRef.current !== handle.tabId) {
      currentTabIdRef.current = handle.tabId;
      lineBufferRef.current = '';
      setCurrentInput('');
      setShowSuggestions(false);
      clearSuggestions();
    }
  }, [handle, clearSuggestions]);

  // Improved suggestion acceptance with partial completion support
  const handleSuggestionAccept = useCallback((command: string) => {
    if (!handle) return;

    console.log('[Terminal] Accepting suggestion:', { command, currentText: lineBufferRef.current });

    // Set flags to prevent re-triggering
    acceptingSuggestionRef.current = true;
    lastAcceptedCommandRef.current = command;

    // Hide suggestions immediately
    setShowSuggestions(false);
    clearSuggestions();

    // Partial completion: if suggestion starts with current input, only add the difference
    const currentText = lineBufferRef.current;
    let textToAdd = command;

    if (command.startsWith(currentText)) {
      // Only add what's new (e.g., "ls" → "ls -lh" adds " -lh")
      textToAdd = command.slice(currentText.length);
      console.log('[Terminal] Partial completion, adding:', textToAdd);
    } else {
      // Full replacement - clear and write entire command
      const backspaces = '\b \b'.repeat(currentText.length);
      textToAdd = backspaces + command;
      console.log('[Terminal] Full replacement:', { backspaces: backspaces.length / 3, newCommand: command });
    }

    // Write to both PTY (for shell input buffer) AND xterm display (for user to see)
    const encoder = new TextEncoder();
    const bytes = encoder.encode(textToAdd);
    console.log('[Terminal] Writing to PTY and xterm:', textToAdd);

    // Write to xterm display immediately (only when local echo is on; with
    // echo off the shell renders what we send to the PTY below).
    if (ENABLE_LOCAL_ECHO) handle.term.write(textToAdd);

    // Write to PTY for shell input buffer
    ptyWrite(handle.tabId, bytes)
      .then(() => {
        console.log('[Terminal] ptyWrite successful');
        // Update our buffer state
        lineBufferRef.current = command;
        setCurrentInput(command);

        // Clear flag after a brief delay
        setTimeout(() => {
          acceptingSuggestionRef.current = false;
          console.log('[Terminal] Cleared accepting flag');
        }, 50);
      })
      .catch((err) => {
        console.error('Failed to accept suggestion:', err);
        acceptingSuggestionRef.current = false;
      });
  }, [handle, clearSuggestions]);

  // Capture Tab before xterm turns it into onData and the PTY writer forwards
  // it to the shell. With no visible result, no listener is installed and
  // native shell completion continues unchanged.
  useEffect(() => {
    if (!showSuggestions || suggestions.length === 0 || selectedSuggestionIndex < 0) return;

    const handleTabCapture = (event: KeyboardEvent) => {
      if (
        event.key !== 'Tab'
        || event.shiftKey
        || event.metaKey
        || event.ctrlKey
        || event.altKey
      ) return;

      const target = event.target as Node | null;
      if (!target || !wrapRef.current?.contains(target)) return;

      const selectedCommand = suggestions[selectedSuggestionIndex]?.command;
      if (!selectedCommand) return;

      event.preventDefault();
      event.stopPropagation();
      handleSuggestionAccept(selectedCommand);
    };

    window.addEventListener('keydown', handleTabCapture, true);
    return () => window.removeEventListener('keydown', handleTabCapture, true);
  }, [handleSuggestionAccept, selectedSuggestionIndex, showSuggestions, suggestions]);

  // Terminal input tracking for suggestions
  // Listen passively to track what user is typing, but don't intercept or prevent anything
  useEffect(() => {
    if (!handle) return;

    // Don't track input when parameter form, NL input, or templates are showing
    if (showParameterForm || showNLInput || showTemplates) {
      return;
    }

    const disposable = handle.term.onData((data: string) => {
      const charCode = data.charCodeAt(0);

      // Track input for AI suggestions (passive observation only)
      // Handle multi-character input (paste)
      if (data.length > 1) {
        // Paste event - append entire pasted string to buffer
        lineBufferRef.current += data;
        setCurrentInput(lineBufferRef.current);
      }
      // Handle backspace (ASCII 127 or 8)
      else if (charCode === 127 || charCode === 8) {
        lineBufferRef.current = lineBufferRef.current.slice(0, -1);
        setCurrentInput(lineBufferRef.current);
      }
      // Handle Enter (ASCII 13) - check for SSH and reset buffer
      else if (charCode === 13) {
        // Check if user just executed an SSH command
        const cmd = lineBufferRef.current.trim().toLowerCase();
        if (cmd.startsWith('ssh ') || cmd === 'ssh') {
          console.log('[Terminal] SSH command detected, disabling local echo');
          if (handle) {
            handle.setRemoteSession(true);
          }
        }

        lineBufferRef.current = '';
        setCurrentInput('');
        setShowSuggestions(false);
        clearSuggestions();
      }
      // Handle Ctrl+C (ASCII 3) - reset buffer
      else if (charCode === 3) {
        lineBufferRef.current = '';
        setCurrentInput('');
        setShowSuggestions(false);
        clearSuggestions();
      }
      // Regular printable characters (but not Tab since we handle it above)
      else if (charCode >= 32 && charCode <= 126 && charCode !== 9) {
        lineBufferRef.current += data;
        setCurrentInput(lineBufferRef.current);
      }
      // For all other characters (arrow keys, etc.), don't track
    });

    return () => disposable.dispose();
  }, [handle, clearSuggestions, showParameterForm, showNLInput, showTemplates]);

  // Keyboard navigation for suggestions (Arrow keys with Cmd modifier)
  // Use Cmd+Up/Down to navigate suggestions, leaving plain arrow keys for xterm
  useEffect(() => {
    if (!handle || !showSuggestions || suggestions.length === 0) return;

    const handleKeyboard = (e: KeyboardEvent) => {
      // Only intercept if the event target is within the terminal container
      const target = e.target as HTMLElement;
      const terminalContainer = wrapRef.current;
      if (!terminalContainer || !terminalContainer.contains(target)) {
        return; // Let other components handle their own keyboard events
      }

      // Cmd+Arrow Down - next suggestion
      if (e.metaKey && e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedSuggestionIndex((prev) =>
          prev < suggestions.length - 1 ? prev + 1 : prev
        );
      }
      // Cmd+Arrow Up - previous suggestion
      else if (e.metaKey && e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedSuggestionIndex((prev) =>
          prev > 0 ? prev - 1 : prev
        );
      }
      // Escape - close suggestions
      else if (e.key === 'Escape') {
        e.preventDefault();
        setShowSuggestions(false);
        clearSuggestions();
      }
      // Plain arrow keys pass through to xterm for command history/cursor movement
    };

    window.addEventListener('keydown', handleKeyboard);
    return () => window.removeEventListener('keydown', handleKeyboard);
  }, [handle, showSuggestions, suggestions, clearSuggestions]);

  // Close context menu on any click
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [contextMenu]);

  // Adjust context menu position after render to account for actual dimensions
  useEffect(() => {
    if (!contextMenu || !contextMenuRef.current) return;

    const menuElement = contextMenuRef.current;
    const rect = menuElement.getBoundingClientRect();

    // Check if menu overflows viewport with actual dimensions
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let adjustedX = contextMenu.x;
    let adjustedY = contextMenu.y;
    let needsAdjustment = false;

    // Adjust if overflowing right edge
    if (rect.right > viewportWidth) {
      adjustedX = viewportWidth - rect.width - 8;
      needsAdjustment = true;
    }

    // Adjust if overflowing bottom edge
    if (rect.bottom > viewportHeight) {
      adjustedY = viewportHeight - rect.height - 8;
      needsAdjustment = true;
    }

    // Ensure menu doesn't go off top or left edges
    adjustedX = Math.max(8, adjustedX);
    adjustedY = Math.max(8, adjustedY);

    if (needsAdjustment) {
      setContextMenu({ ...contextMenu, x: adjustedX, y: adjustedY });
    }
  }, [contextMenu]);

  // Keyboard shortcut for natural language input (Cmd+Shift+K)
  // Only active when terminal container has focus
  // Use capture phase to intercept before ApiTab's Cmd+K listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if event target is within our terminal container
      const target = e.target as HTMLElement;
      const terminalContainer = wrapRef.current;
      if (!terminalContainer || !terminalContainer.contains(target)) {
        return; // Not in this terminal, ignore
      }

      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation(); // Stop other listeners at same level
        setShowNLInput(true);
        // Blur terminal so it doesn't capture keystrokes
        if (handle?.term) {
          handle.term.blur();
        }
      }
    };

    // Use capture phase (true) to fire before other listeners
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // ⌘⇧S — open the Terraform state browser for this terminal's cwd.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const terminalContainer = wrapRef.current;
      if (!terminalContainer || !terminalContainer.contains(target)) return;
      if (e.metaKey && e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        // Prefer this terminal's LIVE cwd (from the shell's OSC 7, keyed by the
        // backend PTY id — which is `handle.tabId`) over the stale spawn-time
        // prop, so the drawer opens where the user actually is.
        const ptyId = handle?.tabId;
        const liveCwd = ptyId
          ? useIacStateStore.getState().cwdByTerminal[ptyId]
          : undefined;
        useIacStateStore.getState().openDrawer(liveCwd ?? cwd ?? ".");
        if (handle?.term) handle.term.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
    // `handle` must be a dep: it starts null and becomes the PTY object after
    // spawn. Without it the listener closes over a stale null tabId and always
    // falls back to the spawn-time cwd instead of the tab's live cwd.
  }, [cwd, handle]);

  // Keyboard shortcut for command templates (Cmd+T)
  // Only active when terminal container has focus
  // Use capture phase to intercept before other listeners
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only handle if event target is within our terminal container
      const target = e.target as HTMLElement;
      const terminalContainer = wrapRef.current;
      if (!terminalContainer || !terminalContainer.contains(target)) {
        return; // Not in this terminal, ignore
      }

      if (e.metaKey && !e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation(); // Stop other listeners at same level
        setShowTemplates(true);
        // Blur terminal so it doesn't capture keystrokes
        if (handle?.term) {
          handle.term.blur();
        }
      }
    };

    // Use capture phase (true) to fire before other listeners
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  // Trigger suggestions when input changes
  useEffect(() => {
    // Don't trigger if we're accepting a suggestion
    if (acceptingSuggestionRef.current) {
      return;
    }

    const trimmed = currentInput.trim();

    // The two-character history minimum remains, with no upper limit. The hook
    // applies AI-only length and inactivity controls.
    if (trimmed.length < 2) {
      setShowSuggestions(false);
      clearSuggestions();
      return;
    }

    getSuggestions(currentInput);
    setShowSuggestions(true);
    setSelectedSuggestionIndex(0);
  }, [currentInput, getSuggestions, clearSuggestions]);

  // Show parameter form when detected
  useEffect(() => {
    if (shouldShow && commandDef && !blocksMode) {
      setShowParameterForm(true);
      setShowSuggestions(false); // Hide suggestions when form shows
      // Blur terminal so it doesn't capture keystrokes
      if (handle?.term) {
        handle.term.blur();
      }
    }
  }, [shouldShow, commandDef, blocksMode, handle]);


  const handleContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!handle) return;
    const selection = handle.term.getSelection();

    // Calculate menu dimensions (approximate) - will be adjusted when rendered
    const menuWidth = 200;
    const menuHeight = 420; // maxHeight from inline styles

    // Get viewport dimensions
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Calculate initial position
    let x = e.clientX;
    let y = e.clientY;

    // Adjust X if menu would overflow right edge
    if (x + menuWidth > viewportWidth) {
      x = viewportWidth - menuWidth - 8; // 8px padding from edge
    }

    // Adjust Y if menu would overflow bottom edge
    if (y + menuHeight > viewportHeight) {
      y = viewportHeight - menuHeight - 8; // 8px padding from edge
    }

    // Ensure menu doesn't go off top or left edges
    x = Math.max(8, x);
    y = Math.max(8, y);

    // Always show context menu, even without selection (for paste)
    setContextMenu({ x, y, selection: selection || '' });
  };

  const handleAskAI = () => {
    if (!contextMenu) return;
    window.dispatchEvent(
      new CustomEvent("ccie:ask-ai-about-selection", {
        detail: { selection: contextMenu.selection },
      })
    );
    setContextMenu(null);
  };

  const handleAskAgent = (agentId: string) => {
    if (!contextMenu) return;
    window.dispatchEvent(
      new CustomEvent("ccie:invoke-agent", {
        detail: {
          agentId,
          selection: contextMenu.selection,
          message: "Explain this terminal output and suggest next steps.",
          autoSend: false, // give user a chance to edit before sending
        },
      })
    );
    setContextMenu(null);
  };

  const handleTroubleshootTerminal = () => {
    if (focusedPaneId) usePanesStore.getState().setFocusedPane(focusedPaneId);
    window.dispatchEvent(
      new CustomEvent("ccie:invoke-agent", {
        detail: {
          agentId: "network-architect",
          message: "Troubleshoot this terminal session.",
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
      console.error('[Terminal] clipboard copy failed:', err);
    }
  };

  const handlePaste = async () => {
    if (!handle) return;
    setContextMenu(null);
    try {
      await pasteClipboardToTerminal(async (text) => {
        // Echo to terminal display first (for immediate feedback). With echo
        // off the shell renders the pasted text itself.
        if (ENABLE_LOCAL_ECHO) handle.term.write(text);
        await ptyWrite(handle.tabId, new TextEncoder().encode(text));
      });
    } catch (err) {
      console.error('[Terminal] clipboard paste failed:', err);
    }
  };

  const handleExportScrollback = async () => {
    if (!handle) return;
    setContextMenu(null);
    await chooseAndExportTerminalScrollback(handle.tabId);
  };

  const handleIngestTopology = async () => {
    if (!contextMenu || !handle) return;
    const selection = contextMenu.selection.trim();
    if (!selection) return;

    // Extract command from the selection (first line, usually)
    const lines = selection.split('\n');
    const firstLine = lines[0].trim();

    // Try to find a topology command in the first few lines
    let command = '';
    for (let i = 0; i < Math.min(5, lines.length); i++) {
      const line = lines[i].trim();
      // Remove prompt prefix if present (e.g., "ISE-OnPrem#show cdp neigh" → "show cdp neigh")
      const cleaned = line.replace(/^[^\s#$>]+[#$>]\s*/, '');
      if (TOPOLOGY_TRIGGER_CMD_RE.test(cleaned)) {
        command = cleaned;
        break;
      }
    }

    if (!command) {
      console.error('[Terminal] No topology command found in selection');
      setContextMenu(null);
      return;
    }

    // Get the tab info for vendor/platform (with fallbacks)
    const tab = useTabs.getState().tabs.find((t) => t.id === handle.tabId);

    // Use defaults if tab not found (can happen after hot reload or with split panes)
    const vendor = tab?.vendor || 'cisco'; // Default to cisco
    const platform = tab?.platform || 'iosxe'; // Default to iosxe
    const deviceRef = tab?.title || 'unknown-device';
    const deviceKind = 'ssh';

    console.log('[Terminal] Using vendor:', vendor, 'platform:', platform, 'device:', deviceRef);

    setContextMenu(null);

    // Show immediate loading indicator
    const statusDiv = document.createElement('div');
    statusDiv.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: var(--surface-2);
      border: 1px solid var(--border-default);
      border-radius: 8px;
      padding: 12px 16px;
      color: var(--text-primary);
      font-size: 14px;
      z-index: 10001;
      box-shadow: 0 4px 12px rgb(var(--backdrop-rgb) / 0.5);
    `;
    statusDiv.textContent = '🗺️ Ingesting topology...';
    document.body.appendChild(statusDiv);

    try {
      console.log('[Terminal] 🗺️ Ingesting topology...');
      console.log('[Terminal] Command:', command);
      console.log('[Terminal] Device:', deviceRef, '| Vendor:', vendor, '| Platform:', platform);
      console.log('[Terminal] Output length:', selection.length, 'chars');
      console.log('[Terminal] Output preview:', selection.substring(0, 200));

      await useTopologyStore.getState().ingestFromText(
        command,
        selection,
        vendor,
        platform,
        deviceRef,
        deviceKind
      );

      console.log('[Terminal] ✅ Topology ingested successfully!');
      console.log('[Terminal] Open the Topology tab (⌘K → "Topology") to view the graph.');

      // Update status to success
      statusDiv.style.borderColor = 'var(--text-primary)';
      statusDiv.textContent = '✅ Topology ingested! Open Topology tab (⌘K) to view.';
      setTimeout(() => {
        document.body.removeChild(statusDiv);
      }, 4000);
    } catch (err) {
      console.error('[Terminal] ❌ Topology ingestion failed:', err);

      // Update status to error
      statusDiv.style.borderColor = 'var(--text-primary)';
      statusDiv.textContent = `❌ Ingestion failed: ${String(err)}`;
      setTimeout(() => {
        if (document.body.contains(statusDiv)) {
          document.body.removeChild(statusDiv);
        }
      }, 5000);
    }
  };

  const menuButtonStyle: React.CSSProperties = {
    display: "block",
    width: "100%",
    textAlign: "left",
    padding: "8px 12px",
    background: "transparent",
    border: "none",
    color: "var(--text-primary)",
    cursor: "pointer",
    borderRadius: "4px",
    fontSize: "13px",
  };

  const handleExecuteCommand = (command: string) => {
    if (!handle) return;

    // Send command to PTY
    const encoder = new TextEncoder();
    const cmdBytes = encoder.encode(command + '\n');

    ptyWrite(handle.tabId, cmdBytes).catch(console.error);
  };

  // Mouse click handler for suggestions
  const handleSuggestionSelect = useCallback((command: string) => {
    handleSuggestionAccept(command);
  }, [handleSuggestionAccept]);

  // Parameter form handlers
  const setPasswordContext = useSshPasswordStore((s) => s.setPasswordContext);

  // Listen for SSH connection requests from saved connections modal
  useEffect(() => {
    const handleSSHConnect = (e: CustomEvent<SshConnectEventDetail>) => {
      if (!handle) return;
      if (e.detail.targetTabId != null && e.detail.targetTabId !== handle.tabId) return;

      const { command, connection, credentials } = e.detail;

      useTerminalConnectionStore.getState().bind({
        terminalId: handle.tabId,
        backendPtyId: handle.tabId,
        connectionId: connection.id,
        displayName: connection.display_name,
        vendor: connection.vendor,
        platform: connection.platform,
        accentColor: connection.accent_color,
        syntaxHighlightingEnabled: connection.syntax_highlighting_enabled,
        syntaxProfile: connection.syntax_profile,
        sshCommand: command,
        lifecycle: 'connecting',
      });

      // Store password context for auto-fill if provided
      useSshPasswordStore.getState().clearPasswordContext(handle.tabId);
      if (credentials.host && credentials.password) {
        console.log('[Terminal] Storing SSH password context for saved connection');
        setPasswordContext(handle.tabId, credentials.host, credentials.user, credentials.password);
      }

      // Mark as SSH session
      console.log('[Terminal] ✓ SSH COMMAND from saved - calling setRemoteSession(true)');
      handle.setRemoteSession(true);

      // Execute the SSH command
      terminalLaunchSavedSsh(handle.tabId, connection.id)
        .catch((err) => {
        console.error('[Terminal] Failed to execute SSH command:', err);
        useSshPasswordStore.getState().clearPasswordContext(handle.tabId);
        useTerminalConnectionStore.getState().setLifecycle(handle.tabId, 'error', {
          error: String(err),
        });
        });
    };

    window.addEventListener('ssh-connect', handleSSHConnect as EventListener);
    return () => {
      window.removeEventListener('ssh-connect', handleSSHConnect as EventListener);
    };
  }, [handle, setPasswordContext]);

  // Workflow execution: receive rendered commands from WorkflowRunner and
  // pipe them through the PTY one at a time. Each command is followed by a
  // newline; consecutive commands are spaced by a small delay so the prior
  // block has a chance to commit before the next is sent.
  useEffect(() => {
    const handleWorkflowExecute = (
      e: CustomEvent<{ tabId: string; commands: string[] }>,
    ) => {
      if (!handle) return;
      if (e.detail.tabId !== handle.tabId) return;
      const cmds = e.detail.commands ?? [];
      if (cmds.length === 0) return;
      const encoder = new TextEncoder();
      (async () => {
        for (const cmd of cmds) {
          try {
            await ptyWrite(handle.tabId, encoder.encode(cmd + '\n'));
          } catch (err) {
            console.error('[Terminal] workflow command failed:', err);
            return;
          }
          if (cmds.length > 1) {
            // Best-effort sequencing fallback. Plan 02 documents this as a
            // TODO tied to a future block-end signal exposed by Plan 01.
            await new Promise((r) => setTimeout(r, 250));
          }
        }
      })();
    };

    window.addEventListener(
      'ccie:workflow-execute',
      handleWorkflowExecute as EventListener,
    );
    return () => {
      window.removeEventListener(
        'ccie:workflow-execute',
        handleWorkflowExecute as EventListener,
      );
    };
  }, [handle]);

  const handleParameterFormSubmit = useCallback((
    command: string,
    metadata?: { host?: string; user?: string; password?: string }
  ) => {
    if (!handle) return;

    // Store password context for auto-fill if provided
    if (metadata?.host && metadata?.password) {
      console.log('[Terminal] Storing SSH password context for auto-fill');
      setPasswordContext(handle.tabId, metadata.host, metadata.user || null, metadata.password);
    }

    // Detect SSH command and disable local echo
    const cmdLower = command.toLowerCase().trim();
    if (cmdLower.startsWith('ssh ') || cmdLower === 'ssh') {
      console.log('[Terminal] ✓ SSH COMMAND - calling setRemoteSession(true)');
      handle.setRemoteSession(true);
    }

    // Clear current input first
    const currentLength = lineBufferRef.current.length;
    const backspaces = '\b \b'.repeat(currentLength);

    const encoder = new TextEncoder();
    const replaceBytes = encoder.encode(backspaces + command + '\n');

    ptyWrite(handle.tabId, replaceBytes)
      .then(() => {
        lineBufferRef.current = '';
        setCurrentInput('');
        setShowParameterForm(false);
      })
      .catch((err) => {
        console.error('Failed to submit parameter form:', err);
      });
  }, [handle, setPasswordContext]);

  const handleParameterFormCancel = useCallback(() => {
    setShowParameterForm(false);
    // Refocus terminal
    if (handle?.term) {
      handle.term.focus();
    }
  }, [handle]);

  // Natural language input handlers
  const handleNLCommandGenerated = useCallback((command: string) => {
    if (!handle) return;

    console.log('[Terminal] NL command generated:', command);

    // Write to xterm display first (for user to see). With echo off the shell
    // echoes the command as the PTY receives it.
    if (ENABLE_LOCAL_ECHO) handle.term.write(command);

    // Write command to PTY and execute it
    const encoder = new TextEncoder();
    const cmdBytes = encoder.encode(command + '\n');

    ptyWrite(handle.tabId, cmdBytes)
      .then(() => {
        console.log('[Terminal] NL command executed');
        setShowNLInput(false);
        // Reset input tracking
        lineBufferRef.current = '';
        setCurrentInput('');
      })
      .catch((err) => {
        console.error('Failed to execute NL command:', err);
      });
  }, [handle]);

  const handleNLClose = useCallback(() => {
    setShowNLInput(false);
    // Refocus terminal
    if (handle?.term) {
      handle.term.focus();
    }
  }, [handle]);

  // Command templates handlers
  const handleTemplateSelected = useCallback((command: string) => {
    if (!handle) return;

    console.log('[Terminal] Template selected:', command);

    // Write to xterm display first (for user to see). With echo off the shell
    // echoes the command as the PTY receives it.
    if (ENABLE_LOCAL_ECHO) handle.term.write(command);

    // Write command to PTY and execute it
    const encoder = new TextEncoder();
    const cmdBytes = encoder.encode(command + '\n');

    ptyWrite(handle.tabId, cmdBytes)
      .then(() => {
        console.log('[Terminal] Template command executed');
        setShowTemplates(false);
        // Reset input tracking
        lineBufferRef.current = '';
        setCurrentInput('');
      })
      .catch((err) => {
        console.error('Failed to execute template command:', err);
      });
  }, [handle]);

  const handleTemplatesClose = useCallback(() => {
    setShowTemplates(false);
    // Refocus terminal
    if (handle?.term) {
      handle.term.focus();
    }
  }, [handle]);

  return (
    <div className="terminal-wrapper" ref={wrapRef}>
      {/* Mode toggle button */}
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

      {/* IMPORTANT: keep this wrapper FIRST and ALWAYS mounted, in a fixed
          tree position. The xterm container below must never change sibling
          order or be conditionally unmounted — doing so makes React call the
          ref with null, which disposes the xterm instance and kills the PTY
          (losing all scrollback). Blocks mode only HIDES this via CSS. */}
      <div
        className="terminal-container"
        style={{
          flex: 1,
          // Keep mounted but visually hidden in blocks mode. Using
          // visibility (not display:none) keeps xterm's measured size stable
          // so output isn't reflowed/lost on toggle.
          display: 'flex',
          visibility: blocksMode ? 'hidden' : 'visible',
          position: blocksMode ? 'absolute' : 'relative',
          inset: blocksMode ? 0 : undefined,
          zIndex: blocksMode ? -1 : undefined,
        }}
      >
        <div
          ref={setXtermContainer}
          className="xterm-container"
          onContextMenu={handleContextMenu}
          onClick={() => handle?.term?.focus()}
          style={{ flex: 1, height: '100%' }}
        />
        <CommandSuggestions
          suggestions={suggestions}
          onSelect={handleSuggestionSelect}
          onClose={() => {
            setShowSuggestions(false);
            clearSuggestions();
          }}
          visible={showSuggestions && !blocksMode}
          selectedIndex={selectedSuggestionIndex}
          loading={loading}
        />
      </div>

      {/* BLOCKS MODE: Command history overlay, layered ON TOP of the always-
          mounted terminal container so the xterm node never moves. */}
      {blocksMode && (
        <div className="blocks-overlay">
          {handle?.tabId ? (
            <BlockList
              tabId={handle.tabId}
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
            disabled={!handle}
          />
        </div>
      )}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="terminal-context-menu"
          style={{
            position: "fixed",
            left: contextMenu.x,
            top: contextMenu.y,
            background: "var(--surface-2)",
            border: "1px solid var(--border-default)",
            borderRadius: "6px",
            boxShadow: "0 4px 12px rgb(var(--backdrop-rgb) / 0.5)",
            padding: "4px",
            zIndex: 10000,
            minWidth: "200px",
            maxHeight: "420px",
            overflowY: "auto",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={handleTroubleshootTerminal}
            style={menuButtonStyle}
            onMouseOver={(e) => (e.currentTarget.style.background = "var(--surface-selected)")}
            onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
          >
            🩺 Troubleshoot with Network Architect
          </button>
          {/* Only show AI and agent options if there's a selection */}
          {contextMenu.selection && contextMenu.selection.trim() && (
            <>
              <button
                onClick={handleAskAI}
                style={menuButtonStyle}
                onMouseOver={(e) => (e.currentTarget.style.background = "var(--surface-selected)")}
                onMouseOut={(e) => (e.currentTarget.style.background = "transparent")}
              >
                ✨ Ask AI about selection
              </button>
              {agents.length > 0 && (
                <div
                  style={{
                    borderTop: "1px solid var(--border-default)",
                    margin: "4px 0",
                    paddingTop: "4px",
                  }}
                >
                  <div
                    style={{
                      padding: "4px 12px",
                      color: "var(--text-muted)",
                      fontSize: "11px",
                      textTransform: "uppercase",
                      letterSpacing: "0.06em",
                    }}
                  >
                    Ask agent
                  </div>
                  {agents.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => handleAskAgent(a.id)}
                      style={menuButtonStyle}
                      onMouseOver={(e) =>
                        (e.currentTarget.style.background = "var(--surface-selected)")
                      }
                      onMouseOut={(e) =>
                        (e.currentTarget.style.background = "transparent")
                      }
                      title={a.description}
                    >
                      🤖 {a.name}
                    </button>
                  ))}
                </div>
              )}
              {/* Topology ingestion option - only show if selection contains a topology command */}
              {contextMenu.selection.split('\n').slice(0, 5).some(line => {
                // Remove prompt prefix if present (e.g., "ISE-OnPrem#show cdp neigh")
                const cleaned = line.replace(/^[^\s#$>]+[#$>]\s*/, '').trim();
                return TOPOLOGY_TRIGGER_CMD_RE.test(cleaned);
              }) && (
                <>
                  <div
                    style={{
                      borderTop: "1px solid var(--border-default)",
                      margin: "4px 0",
                    }}
                  />
                  <button
                    onClick={handleIngestTopology}
                    style={menuButtonStyle}
                    onMouseOver={(e) =>
                      (e.currentTarget.style.background = "var(--surface-selected)")
                    }
                    onMouseOut={(e) =>
                      (e.currentTarget.style.background = "transparent")
                    }
                    title="Parse and add neighbors to topology graph"
                  >
                    🗺️ Ingest Topology
                  </button>
                </>
              )}
              <div
                style={{
                  borderTop: "1px solid var(--border-default)",
                  margin: "4px 0",
                }}
              />
            </>
          )}
          <div
            style={{
              paddingTop: contextMenu.selection && contextMenu.selection.trim() ? "4px" : "0",
            }}
          >
            {/* Only show Copy if there's a selection */}
            {contextMenu.selection && contextMenu.selection.trim() && (
              <button
                onClick={handleCopy}
                style={menuButtonStyle}
                onMouseOver={(e) =>
                  (e.currentTarget.style.background = "var(--surface-selected)")
                }
                onMouseOut={(e) =>
                  (e.currentTarget.style.background = "transparent")
                }
              >
                📋 Copy
              </button>
            )}
            {/* Paste always available */}
            <button
              onClick={handlePaste}
              style={menuButtonStyle}
              onMouseOver={(e) =>
                (e.currentTarget.style.background = "var(--surface-selected)")
              }
              onMouseOut={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              📄 Paste
            </button>
            <button
              onClick={() => void handleExportScrollback()}
              style={menuButtonStyle}
              onMouseOver={(e) =>
                (e.currentTarget.style.background = "var(--surface-selected)")
              }
              onMouseOut={(e) =>
                (e.currentTarget.style.background = "transparent")
              }
            >
              🧾 Export redacted scrollback…
            </button>
          </div>
        </div>
      )}

      {/* Parameter Form Modal */}
      {showParameterForm && commandDef && (
        <ParameterForm
          commandDef={commandDef}
          onSubmit={handleParameterFormSubmit}
          onCancel={handleParameterFormCancel}
        />
      )}

      {/* Natural Language Input Modal */}
      {showNLInput && activeTabId && (
        <NaturalLanguageInput
          onCommandGenerated={handleNLCommandGenerated}
          onClose={handleNLClose}
          cwd={cwd}
          tabId={activeTabId}
          paneId={focusedPaneId ?? undefined}
        />
      )}

      {/* Command Templates Modal */}
      {showTemplates && (
        <CommandTemplates
          onTemplateSelected={handleTemplateSelected}
          onClose={handleTemplatesClose}
        />
      )}
    </div>
  );
});

export const Terminal = memo(function Terminal(props: TerminalProps) {
  if (ENABLE_TERMINAL_REGISTRY && props.terminalId) {
    return <TerminalSlot
      terminalId={props.terminalId}
      shell={props.shell}
      cwd={props.cwd}
      skipTabRegistration={props.skipTabRegistration}
      attach={props.attach}
      replayBytes={props.replayBytes}
      onRegistered={props.onRegistered}
    />;
  }
  return <LegacyTerminal {...props} />;
});
