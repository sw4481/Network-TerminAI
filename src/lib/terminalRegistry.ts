import { ptySpawn, ptyKill, ptyResize, ptyWrite } from './tauri';
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

export interface CreateOpts {
  shell: string;
  cwd: string;
  skipTabRegistration?: boolean;
  /** Restore: reuse this saved tab id so scrollback/pane_layouts line up. */
  preferredTabId?: string;
  /** Restore: raw scrollback bytes to replay above the fresh shell. */
  replayBytes?: number[];
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

export function getOrCreate(terminalId: string, opts: CreateOpts): TerminalEntry {
  const existing = registry.get(terminalId);
  if (existing) return existing;

  // Resolve CDN xterm constructors (same shape as usePty.ts:84-87).
  const XTerm = (window as any).Terminal;
  const FitAddonCtor = (window as any).FitAddon?.FitAddon || (window as any).FitAddon;
  const WebLinksCtor = (window as any).WebLinksAddon?.WebLinksAddon || (window as any).WebLinksAddon;
  const ClipboardCtor = (window as any).ClipboardAddon?.ClipboardAddon || (window as any).ClipboardAddon;
  if (!XTerm || !FitAddonCtor) {
    throw new Error('terminalRegistry: xterm not loaded from CDN yet');
  }

  const el = document.createElement('div');
  el.className = 'terminal-registry-surface';
  el.style.width = '100%';
  el.style.height = '100%';

  const xterm = new XTerm(createTerminalOptions(currentAppearance));
  const fitAddon = new FitAddonCtor();
  xterm.loadAddon(fitAddon);
  if (WebLinksCtor) xterm.loadAddon(new WebLinksCtor());
  if (ClipboardCtor) xterm.loadAddon(new ClipboardCtor());
  // NOTE: do NOT call xterm.open(el) here — `el` is detached from the DOM at
  // this point, and xterm's renderer initializes against a 0x0/offscreen node
  // and never paints (blank terminal: no prompt, no echo). open() is deferred
  // to the first attach(), when `el` is actually in the document.

  if (opts.replayBytes && opts.replayBytes.length > 0) {
    xterm.write(new Uint8Array(opts.replayBytes));
    // Dim separator marks where restored history ends and the live shell begins.
    xterm.write("\r\n\x1b[2m──── session restored ────\x1b[0m\r\n");
  }

  const entry: TerminalEntry = {
    xterm,
    fitAddon,
    el,
    ptyTabId: null,
    disposed: false,
    opened: false,
  };
  registry.set(terminalId, entry);

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

  // (1) Copy / paste shortcuts.
  //   • macOS: Cmd+C / Cmd+V (the platform-standard clipboard shortcut).
  //   • Windows/Linux: Ctrl+C / Ctrl+V.
  // On macOS the terminal's SIGINT stays on Ctrl+C (unchanged); Cmd+C is a
  // copy-only key there, so it never needs to fall through as an interrupt.
  const isMac = navigator.platform.toUpperCase().includes('MAC');
  xterm.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
    if (e.type !== 'keydown') return true;
    if (e.altKey) return true;

    // The copy/paste modifier is Cmd on Mac, Ctrl elsewhere. Require ONLY that
    // modifier (so e.g. Ctrl+Cmd combos don't accidentally trigger).
    const copyPasteChord = isMac
      ? e.metaKey && !e.ctrlKey
      : e.ctrlKey && !e.metaKey;
    if (!copyPasteChord) return true;

    // Copy: copy selection if present.
    // On Windows/Linux with no selection, Ctrl+C must still pass through as the
    // shell interrupt (SIGINT). On Mac, Cmd+C is copy-only.
    if (e.key === 'c' || e.key === 'C') {
      const selection = xterm.getSelection();
      if (selection && selection.length > 0) {
        e.preventDefault();
        navigator.clipboard.writeText(selection).catch((err) => {
          console.error('[terminalRegistry] clipboard copy failed:', err);
        });
        return false; // handled — don't send ^C
      }
      // No selection: on Mac swallow Cmd+C (not an interrupt key); on
      // Windows/Linux let Ctrl+C through so it reaches the shell as SIGINT.
      return !isMac;
    }

    // Paste: write clipboard contents into the PTY.
    if (e.key === 'v' || e.key === 'V') {
      e.preventDefault();
      navigator.clipboard
        .readText()
        .then((text) => {
          if (text && ptyTabId) {
            ptyWrite(ptyTabId, new TextEncoder().encode(text)).catch((err) => {
              console.error('[terminalRegistry] paste ptyWrite failed:', err);
            });
          }
        })
        .catch((err) => {
          console.error('[terminalRegistry] clipboard read failed:', err);
        });
      return false; // handled — don't send ^V
    }

    return true; // every other chord behaves normally
  });

  const onEvent = (e: PtyEvent) => {
    if (entry.disposed) return;
    switch (e.type) {
      case 'output': {
        // Port from usePty.ts:177-250 (write bytes; SSH-exit detect; password autofill)
        const text = new TextDecoder().decode(new Uint8Array(e.bytes));
        xterm.write(new Uint8Array(e.bytes));

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
        if (ptyTabId) {
          const blockId = useBlocksStore.getState().addBlock(ptyTabId, e.cmd, liveCwd);
          currentBlockId = blockId;
          blockStartTime = Date.now();
          outputBuffer = '';
        }
        break;
      }
      case 'command_end': {
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
      case 'exit': {
        if (ptyTabId) useTabs.getState().removeTab(ptyTabId);
        dispose(terminalId); // shell exit = explicit dispose trigger
        break;
      }
    }
  };

  const promise = ptySpawn({
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
  const handleSshConnect = (
    e: CustomEvent<{
      command: string;
      targetTabId: string | null;
      metadata: { host: string; user: string | null; password: string | null };
    }>,
  ) => {
    if (!ptyTabId) return;
    // Match the resolved target against BOTH ids (see workflow handler). A
    // null target (older callers) falls through so a single terminal still
    // responds.
    const { targetTabId } = e.detail;
    if (targetTabId != null && targetTabId !== ptyTabId && targetTabId !== terminalId) {
      return;
    }

    const { command, metadata } = e.detail;
    // Store the password so the output-scanner (case 'output' above) can
    // auto-fill it when the switch prompts. Keyed by ptyTabId.
    if (metadata.host && metadata.password) {
      useSshPasswordStore
        .getState()
        .setPasswordContext(ptyTabId, metadata.host, metadata.user, metadata.password);
    }

    ptyWrite(ptyTabId, new TextEncoder().encode(command + '\n')).catch((err) => {
      console.error('[terminalRegistry] Failed to execute SSH command:', err);
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
  registry.clear();
  currentAppearance = createDefaultAppearanceSettings();
}
