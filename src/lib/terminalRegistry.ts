import { ptySpawn, ptyKill, ptyResize, ptyWrite, terminalLaunchSavedSsh } from './tauri';
import { listen } from '@tauri-apps/api/event';
import type { PtyEvent } from './types';
import stripAnsi from 'strip-ansi';
import { useTabs } from '../state/tabsStore';
import { useIacStateStore } from '../state/iacStateStore';
import { useBlocksStore } from '../state/blocksStore';
import { useSshPasswordStore } from '../state/sshPasswordStore';
import { createDefaultAppearanceSettings } from '../theme/defaults';
import type { AppearanceSettingsV1 } from '../theme/types';
import {
  applyTerminalOptions,
  createTerminalOptions,
  terminalMetricsChanged,
} from './terminalAppearance';
import {
  createTerminalSearchHandle,
  type TerminalSearchHandle,
} from './terminalSearch';
import {
  handleTerminalClipboardShortcut,
  normalizeTerminalPlatform,
} from './terminalClipboard';
import type { SshConnectEventDetail } from './sshConnections';
import { useTerminalConnectionStore } from '../state/terminalConnectionStore';
import {
  TerminalSyntaxHighlighter,
  writeTerminalOutput,
} from './terminalSyntaxHighlighter';
import {
  handleSavedSshCommandEnd,
  handleSavedSshCommandStart,
} from './sshLifecycle';

export interface CreateOpts {
  shell: string;
  cwd: string;
  skipTabRegistration?: boolean;
  /** Restore: reuse this saved tab id so scrollback/pane_layouts line up. */
  preferredTabId?: string;
  /** Restore: raw scrollback bytes to replay above the fresh shell. */
  replayBytes?: number[];
  /** Attach to an existing PTY from another Tauri webview. */
  attach?: boolean;
  /**
   * Fired once the backend PTY id is known. For a freshly-created terminal the
   * spawn is async, so the caller cannot read `entry.ptyTabId` synchronously —
   * this callback delivers it when the spawn resolves (needed so split-pane
   * `pending-*` terminalIds reconcile to the real PTY id).
   */
  onPtyReady?: (ptyTabId: string) => void;
}

export interface TerminalEntry {
  xterm: any;
  fitAddon: any;
  searchAddon: any;
  search: TerminalSearchHandle;
  el: HTMLDivElement;
  ptyTabId: string | null;
  disposed: boolean;
  /** Whether xterm.open() has run — deferred to the first attach (el must be
   * in the live DOM, else the renderer stays blank). */
  opened: boolean;
  _ptySpawnPromise?: Promise<string>;
  _resizeObserver?: ResizeObserver;
  _workflowHandler?: EventListener;
  _sshConnectHandler?: EventListener;
  syntaxHighlighter: TerminalSyntaxHighlighter;
  _connectionUnsubscribe?: () => void;
  _ptyEventUnsubscribe?: () => void;
}

const registry = new Map<string, TerminalEntry>();
let currentAppearance = createDefaultAppearanceSettings();

// Commands queued to run in a terminal that isn't live yet. Keyed by the
// registry terminalId (which, for a freshly-spawned terminal tab, equals the
// tab id). Drained in wireSession once the PTY resolves. This is how
// run-in-terminal survives the LegacyTerminal→PaneContainer handoff: the slot
// that first mounts is torn down and replaced by the registry-backed pane, so
// piping to the original PTY is lost — but a command parked here is delivered
// to whichever PTY the registry ends up owning for that id.
const pendingCommands = new Map<string, string>();

export function has(terminalId: string): boolean {
  return registry.has(terminalId);
}

/**
 * Run `command` in the terminal identified by `terminalId`, waiting for its
 * PTY if the spawn hasn't resolved yet. If the PTY is already live, writes
 * immediately; otherwise the command is parked and delivered when wireSession's
 * spawn resolves. A trailing newline is added so the shell executes the line.
 */
export function runWhenReady(terminalId: string, command: string): void {
  const entry = registry.get(terminalId);
  if (entry && entry.ptyTabId && !entry.disposed) {
    ptyWrite(entry.ptyTabId, new TextEncoder().encode(command + '\n')).catch((err) => {
      console.error('[terminalRegistry] runWhenReady write failed:', err);
    });
    return;
  }
  pendingCommands.set(terminalId, command);
}

/**
 * Resolve a pane's stable `terminalId` to the backend PTY id the session
 * actually spawned (`entry.ptyTabId`). Backend pane-activity events are keyed
 * by this PTY id, NOT the terminalId, so activity-indicator lookups must
 * resolve through here. Returns null until the async spawn has resolved.
 */
export function ptyTabIdFor(terminalId: string): string | null {
  return registry.get(terminalId)?.ptyTabId ?? null;
}

/**
 * Read the current text selection in a terminal's xterm instance, if any.
 * Used by Pane's context menu (selection-gated menu items). Returns "" for
 * an unknown terminalId or when nothing is selected.
 */
export function getSelection(terminalId: string): string {
  const entry = registry.get(terminalId);
  if (!entry) return '';
  return entry.xterm.getSelection() ?? '';
}

/** Return the narrow search controller for one persistent xterm. */
export function searchHandleFor(terminalId: string): TerminalSearchHandle | null {
  return registry.get(terminalId)?.search ?? null;
}

export function getOrCreate(terminalId: string, opts: CreateOpts): TerminalEntry {
  const existing = registry.get(terminalId);
  if (existing) return existing;

  // Resolve CDN xterm constructors (same shape as usePty.ts:84-87).
  const XTerm = (window as any).Terminal;
  const FitAddonCtor = (window as any).FitAddon?.FitAddon || (window as any).FitAddon;
  const WebLinksCtor = (window as any).WebLinksAddon?.WebLinksAddon || (window as any).WebLinksAddon;
  const ClipboardCtor = (window as any).ClipboardAddon?.ClipboardAddon || (window as any).ClipboardAddon;
  const SearchAddonCtor = (window as any).SearchAddon?.SearchAddon || (window as any).SearchAddon;
  if (!XTerm || !FitAddonCtor || !SearchAddonCtor) {
    throw new Error('terminalRegistry: xterm not loaded from CDN yet');
  }

  const el = document.createElement('div');
  el.className = 'terminal-registry-surface';
  el.style.width = '100%';
  el.style.height = '100%';

  const xterm = new XTerm(createTerminalOptions(currentAppearance));
  const fitAddon = new FitAddonCtor();
  const searchAddon = new SearchAddonCtor();
  xterm.loadAddon(fitAddon);
  if (WebLinksCtor) xterm.loadAddon(new WebLinksCtor());
  if (ClipboardCtor) xterm.loadAddon(new ClipboardCtor());
  xterm.loadAddon(searchAddon);
  // NOTE: do NOT call xterm.open(el) here — `el` is detached from the DOM at
  // this point, and xterm's renderer initializes against a 0x0/offscreen node
  // and never paints (blank terminal: no prompt, no echo). open() is deferred
  // to the first attach(), when `el` is actually in the document.

  if (opts.replayBytes && opts.replayBytes.length > 0) {
    xterm.write(new Uint8Array(opts.replayBytes));
    // Dim separator marks where restored history ends and the live shell begins.
    xterm.write("\r\n\x1b[2m──── session restored ────\x1b[0m\r\n");
  }

  const syntaxHighlighter = new TerminalSyntaxHighlighter(xterm, () => {
    const connection = useTerminalConnectionStore.getState().get(terminalId);
    if (!connection) return null;
    return {
      enabled: connection.syntax_highlighting_enabled,
      profile: connection.syntax_profile,
      vendor: connection.vendor,
      platform: connection.platform,
    };
  });
  const entry: TerminalEntry = {
    xterm,
    fitAddon,
    searchAddon,
    search: createTerminalSearchHandle(xterm, searchAddon),
    el,
    ptyTabId: null,
    disposed: false,
    opened: false,
    syntaxHighlighter,
  };
  registry.set(terminalId, entry);
  let previousSyntaxKey = "";
  entry._connectionUnsubscribe = useTerminalConnectionStore.subscribe((state) => {
    const connection = state.byTerminalId[terminalId];
    const nextSyntaxKey = connection
      ? `${connection.syntax_highlighting_enabled}:${connection.syntax_profile}:${connection.vendor}:${connection.platform}`
      : "";
    if (nextSyntaxKey === previousSyntaxKey) return;
    previousSyntaxKey = nextSyntaxKey;
    syntaxHighlighter.refreshVisible();
  });

  // Wire input/output/resize + spawn the PTY (Task 3 fills wireSession).
  wireSession(entry, terminalId, opts);

  return entry;
}

export function attach(terminalId: string, slot: HTMLDivElement): void {
  const entry = registry.get(terminalId);
  if (!entry || entry.disposed) return;
  slot.appendChild(entry.el);
  // Open xterm on the FIRST attach, now that `el` is in the live DOM — opening
  // earlier (on a detached node) leaves the renderer permanently blank.
  if (!entry.opened) {
    entry.xterm.open(entry.el);
    entry.opened = true;
  }
  try {
    entry.fitAddon.fit();
    const rows = entry.xterm.rows ?? 24;
    entry.xterm.refresh(0, Math.max(0, rows - 1));
  } catch {
    /* fit can throw if the slot has zero size mid-layout; harmless */
  }
}

export function detach(terminalId: string): void {
  const entry = registry.get(terminalId);
  if (!entry) return;
  entry.el.remove(); // detach DOM node; KEEP the entry alive
}

/** Apply an approved appearance snapshot without touching PTY/session state. */
export function applyAppearanceSettings(settings: AppearanceSettingsV1): void {
  const nextOptions = createTerminalOptions(settings);
  const previousOptions = createTerminalOptions(currentAppearance);
  currentAppearance = settings;
  const metricsChanged = terminalMetricsChanged(previousOptions, nextOptions);

  for (const entry of registry.values()) {
    if (entry.disposed) continue;
    applyTerminalOptions(entry.xterm, nextOptions);
    if (!metricsChanged) continue;
    try {
      entry.fitAddon.fit();
      const rows = entry.xterm.rows ?? 24;
      entry.xterm.refresh(0, Math.max(0, rows - 1));
      if (entry.ptyTabId) {
        ptyResize(entry.ptyTabId, entry.xterm.cols, entry.xterm.rows).catch(() => {});
      }
    } catch {
      /* detached or zero-size terminals safely retain their existing session */
    }
  }
}

export function dispose(terminalId: string): void {
  const entry = registry.get(terminalId);
  if (!entry) return;
  entry.disposed = true;
  // Stop observing resize so the detached element + closure can be GC'd
  // (el.remove() alone does not disconnect a ResizeObserver).
  if (entry._resizeObserver) {
    entry._resizeObserver.disconnect();
  }
  // Remove workflow event listener to prevent memory leaks
  if (entry._workflowHandler) {
    window.removeEventListener('ccie:workflow-execute', entry._workflowHandler);
  }
  // Remove ssh-connect listener to prevent memory leaks
  if (entry._sshConnectHandler) {
    window.removeEventListener('ssh-connect', entry._sshConnectHandler);
  }
  entry._ptyEventUnsubscribe?.();
  entry._connectionUnsubscribe?.();
  entry.syntaxHighlighter.dispose();
  // If PTY spawn is pending, wait for it then kill
  if (entry._ptySpawnPromise) {
    entry._ptySpawnPromise.then((id) => {
      ptyKill(id).catch(() => {});
    }).catch(() => {});
  } else if (entry.ptyTabId) {
    ptyKill(entry.ptyTabId).catch(() => {});
  }
  try {
    entry.xterm.dispose();
  } catch {
    /* already disposed */
  }
  entry.el.remove();
  registry.delete(terminalId);
  useTerminalConnectionStore.getState().clear(terminalId);
}

// Full PTY event wiring, ported from usePty.ts (lines 70-370).
function wireSession(entry: TerminalEntry, terminalId: string, opts: CreateOpts): void {
  const { xterm } = entry;
  let ptyTabId: string | null = null;
  let lastOutput = '';
  let inRemote = false;
  let passwordSent = false;
  let liveCwd = opts.cwd;
  let currentBlockId: string | null = null;
  let blockStartTime = 0;
  let outputBuffer = '';
  let currentShellCommand: string | null = null;

  const terminalPlatform = normalizeTerminalPlatform();
  xterm.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
    return handleTerminalClipboardShortcut(e, {
      platform: terminalPlatform,
      selection: xterm.getSelection() ?? '',
      write: async (text) => {
        if (!ptyTabId) return;
        await ptyWrite(ptyTabId, new TextEncoder().encode(text));
      },
      onError: (err) => console.error('[terminalRegistry] clipboard action failed:', err),
    });
  });

  const onEvent = (e: PtyEvent) => {
    if (entry.disposed) return;
    switch (e.type) {
      case 'output': {
        // Port from usePty.ts:177-250 (write bytes; SSH-exit detect; password autofill)
        const text = new TextDecoder().decode(new Uint8Array(e.bytes));
        writeTerminalOutput(xterm, entry.syntaxHighlighter, new Uint8Array(e.bytes));

        // Track recent output for password detection and SSH exit detection
        lastOutput += text;
        if (lastOutput.length > 500) {
          lastOutput = lastOutput.slice(-500);
        }

        // Detect when SSH session ends (back to local prompt)
        if (ptyTabId && inRemote) {
          const sshExitPattern = /Connection to [^\s]+ closed/;
          if (sshExitPattern.test(lastOutput)) {
            console.log('[terminalRegistry] ✓ SSH session ended (detected exit message)');
            inRemote = false;
            lastOutput = '';
          }
        }

        // Detect password prompts and auto-fill if we have a stored password
        if (ptyTabId) {
          const lowerOutput = lastOutput.toLowerCase();
          const hasPasswordPrompt =
            lowerOutput.includes('password:') ||
            lowerOutput.includes('password for') ||
            lowerOutput.includes('password?') ||
            lowerOutput.match(/\bpassword\s*[:?]/);

          if (hasPasswordPrompt && !passwordSent) {
            const context = useSshPasswordStore.getState().getPasswordContext(ptyTabId);
            if (context) {
              console.log('[terminalRegistry] ✓ SENDING PASSWORD');
              passwordSent = true;
              const encoder = new TextEncoder();
              const passwordBytes = encoder.encode(context.password + '\n');

              // Auto-send password
              setTimeout(() => {
                ptyWrite(ptyTabId!, passwordBytes).then(() => {
                  // Clear password context IMMEDIATELY to prevent re-use
                  useSshPasswordStore.getState().clearPasswordContext(ptyTabId!);
                  // Clear the output buffer to prevent re-triggering on stale "password:" text
                  lastOutput = '';
                  // Reset flag after short delay
                  setTimeout(() => {
                    passwordSent = false;
                  }, 2000);
                }).catch((err) => {
                  console.error('[terminalRegistry] Failed to auto-fill password:', err);
                  passwordSent = false;
                });
              }, 100);
            }
          }
        }

        // Buffer output for current block
        if (currentBlockId) {
          outputBuffer += text;
        }
        break;
      }
      case 'command_start': {
        currentShellCommand = e.cmd;
        if (ptyTabId) {
          if (handleSavedSshCommandStart(ptyTabId, e.cmd)) inRemote = true;
          const blockId = useBlocksStore.getState().addBlock(ptyTabId, e.cmd, liveCwd);
          currentBlockId = blockId;
          blockStartTime = Date.now();
          outputBuffer = '';
        }
        break;
      }
      case 'command_end': {
        if (ptyTabId) {
          handleSavedSshCommandEnd(ptyTabId, currentShellCommand, e.exit_code ?? null);
        }
        currentShellCommand = null;
        if (currentBlockId) {
          // Complete current block - strip ANSI codes from output
          const duration = Date.now() - blockStartTime;
          const cleanOutput = stripAnsi(outputBuffer);
          useBlocksStore.getState().completeBlock(
            currentBlockId,
            e.exit_code ?? -1,
            duration,
            cleanOutput
          );

          currentBlockId = null;
          outputBuffer = '';
        }
        break;
      }
      case 'cwd': {
        liveCwd = e.path;
        if (ptyTabId) {
          useIacStateStore.getState().setTerminalCwd(ptyTabId, e.path);
          useTabs.getState().setCwd(ptyTabId, e.path);
        }
        break;
      }
      case 'enter_alt_screen': {
        entry.syntaxHighlighter.enterAlternateScreen();
        break;
      }
      case 'exit_alt_screen': {
        entry.syntaxHighlighter.exitAlternateScreen();
        break;
      }
      case 'exit': {
        if (ptyTabId) useTabs.getState().removeTab(ptyTabId);
        dispose(terminalId); // shell exit = explicit dispose trigger
        break;
      }
    }
  };

  const promise = opts.attach
    ? listen<{ tabId: string; event: PtyEvent }>('pty-event', (event) => {
        if (event.payload.tabId === terminalId) onEvent(event.payload.event);
      }).then((stop) => {
        entry._ptyEventUnsubscribe = stop;
        return terminalId;
      })
    : ptySpawn({
        shell: opts.shell,
        args: [],
        cwd: opts.cwd,
        cols: xterm.cols ?? 80,
        rows: xterm.rows ?? 24,
        onEvent,
        preferredTabId: opts.preferredTabId,
      });
  entry._ptySpawnPromise = promise;

  promise.then((id: string) => {
    if (entry.disposed) return;
    ptyTabId = id;
    entry.ptyTabId = id;
    opts.onPtyReady?.(id);

    if (!opts.skipTabRegistration) {
      useTabs.getState().addTab({
        id,
        title: opts.shell.split('/').pop() ?? opts.shell,
        shell_cmd: opts.shell,
        cwd: opts.cwd,
        created_at: Date.now() / 1000,
        tab_type: 'terminal',
      });
    }

    xterm.onData((data: string) => {
      const bytes = new TextEncoder().encode(data);
      ptyWrite(id, bytes).catch(() => {});
    });

    // Deliver any command parked by runWhenReady() before this PTY was live
    // (run-in-terminal: the command outlives the LegacyTerminal→pane handoff).
    const parked = pendingCommands.get(terminalId);
    if (parked !== undefined) {
      pendingCommands.delete(terminalId);
      ptyWrite(id, new TextEncoder().encode(parked + '\n')).catch((err) => {
        console.error('[terminalRegistry] parked command write failed:', err);
      });
    }

    // Now that ptyTabId is set, workflow events can be handled correctly
    console.log(`[terminalRegistry] PTY ${id} ready, workflow events will now work`);
  });

  // (4) Handle workflow execution custom events (workflow picker dispatches these).
  //     Port from LegacyTerminal lines 670-706 in Terminal.tsx
  const handleWorkflowExecute = (
    e: CustomEvent<{ tabId: string; commands: string[] }>,
  ) => {
    console.log('[terminalRegistry] workflow event received:', {
      eventTabId: e.detail.tabId,
      terminalId,
      ptyTabId,
      commands: e.detail.commands,
    });
    if (!ptyTabId) {
      console.warn('[terminalRegistry] workflow event ignored: ptyTabId not set yet');
      return;
    }
    // Match against BOTH terminalId (registry key, often the original tab ID)
    // AND ptyTabId (backend PTY ID). With skipTabRegistration=true, these may differ.
    if (e.detail.tabId !== ptyTabId && e.detail.tabId !== terminalId) {
      console.log('[terminalRegistry] workflow event ignored: tab mismatch (neither ptyTabId nor terminalId)');
      return;
    }
    const cmds = e.detail.commands ?? [];
    if (cmds.length === 0) {
      console.warn('[terminalRegistry] workflow event ignored: no commands');
      return;
    }
    console.log('[terminalRegistry] executing workflow commands:', cmds);
    const encoder = new TextEncoder();
    (async () => {
      for (const cmd of cmds) {
        try {
          console.log('[terminalRegistry] writing command to PTY:', cmd);
          await ptyWrite(ptyTabId!, encoder.encode(cmd + '\n'));
        } catch (err) {
          console.error('[terminalRegistry] workflow command failed:', err);
          return;
        }
        if (cmds.length > 1) {
          // Best-effort sequencing fallback. Plan 02 documents this as a
          // TODO tied to a future block-end signal exposed by Plan 01.
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      console.log('[terminalRegistry] workflow execution complete');
    })();
  };

  window.addEventListener(
    'ccie:workflow-execute',
    handleWorkflowExecute as EventListener,
  );
  entry._workflowHandler = handleWorkflowExecute as EventListener;

  // (4b) Handle SSH-connect requests from the Saved SSH Connections modal.
  //      This used to live in LegacyTerminal, but with the terminal registry
  //      enabled that component never mounts, so the event was dropped and
  //      "Connect" did nothing. Route it to the targeted PTY here instead.
  const handleSshConnect = (e: CustomEvent<SshConnectEventDetail>) => {
    if (!ptyTabId) return;
    const acceptedPtyId = ptyTabId;
    // Match the resolved target against BOTH ids (see workflow handler). A
    // null target (older callers) falls through so a single terminal still
    // responds.
    const { targetTabId } = e.detail;
    if (targetTabId != null && targetTabId !== acceptedPtyId && targetTabId !== terminalId) {
      return;
    }

    const { command, connection, credentials } = e.detail;
    useTerminalConnectionStore.getState().bind({
      terminalId,
      backendPtyId: acceptedPtyId,
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
    // Store the password so the output-scanner (case 'output' above) can
    // auto-fill it when the switch prompts. Keyed by ptyTabId.
    useSshPasswordStore.getState().clearPasswordContext(acceptedPtyId);
    if (credentials.host && credentials.password) {
      useSshPasswordStore
        .getState()
        .setPasswordContext(acceptedPtyId, credentials.host, credentials.user, credentials.password);
    }

    terminalLaunchSavedSsh(acceptedPtyId, connection.id)
      .catch((err) => {
      console.error('[terminalRegistry] Failed to execute SSH command:', err);
      useSshPasswordStore.getState().clearPasswordContext(acceptedPtyId);
      useTerminalConnectionStore.getState().setLifecycle(terminalId, 'error', {
        error: String(err),
      });
      });
  };

  window.addEventListener('ssh-connect', handleSshConnect as EventListener);
  entry._sshConnectHandler = handleSshConnect as EventListener;

  // (5) keep PTY rows/cols in sync when the surface resizes.
  const ro = new ResizeObserver(() => {
    try {
      entry.fitAddon.fit();
      if (ptyTabId) ptyResize(ptyTabId, xterm.cols, xterm.rows).catch(() => {});
    } catch { /* zero-size mid-layout */ }
  });
  ro.observe(entry.el);
  entry._resizeObserver = ro;
}

export function __resetForTest(): void {
  for (const entry of registry.values()) {
    entry._connectionUnsubscribe?.();
    entry.syntaxHighlighter.dispose();
  }
  registry.clear();
  useTerminalConnectionStore.setState({ byTerminalId: {}, terminalIdByBackendPtyId: {} });
  currentAppearance = createDefaultAppearanceSettings();
}
