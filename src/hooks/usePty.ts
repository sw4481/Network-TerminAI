import { useEffect, useRef, useState } from "react";
import stripAnsi from "strip-ansi";
import { ptySpawn, ptyWrite, ptyResize } from "../lib/tauri";
import { useTabs } from "../state/tabsStore";
import { useIacStateStore } from "../state/iacStateStore";
import { useBlocksStore } from "../state/blocksStore";
import { useSshPasswordStore } from "../state/sshPasswordStore";
import type { PtyEvent } from "../lib/types";

// Use xterm from CDN (loaded via script tags in index.html)
declare global {
  interface Window {
    Terminal: any;
    FitAddon: any;
    WebLinksAddon: any;
    ClipboardAddon: any;
  }
}

/**
 * REVERT SWITCH — set to `true` to restore the old JS-side local echo.
 *
 * Local echo is OFF by default so the PTY's TTY line discipline and the
 * shell's line editor (zsh `zle` / bash readline) own the line entirely.
 * That is what makes Tab completion, ↑ history, Ctrl+R reverse-search, and
 * Ctrl+A/E cursor movement work — exactly like iTerm/Terminal.app.
 *
 * Flipping this back to `true` reinstates the previous behavior verbatim
 * (echo locally, gated by `inRemoteSessionRef`) if anything regresses.
 */
export const ENABLE_LOCAL_ECHO = false;

// Phase: persistent terminal registry. When true, Terminal.tsx routes through
// the out-of-React terminalRegistry (xterm+PTY survive splits/tab-switches).
// When false, the legacy usePty path below runs unchanged. One-line rollback.
export const ENABLE_TERMINAL_REGISTRY = true;

export type PtyHandle = {
  term: any;
  fit: () => void;
  dispose: () => void;
  /** The PTY / tab id this handle owns, once the spawn completes. */
  tabId: string;
  /** Mark that we're in a remote session (SSH/telnet) to disable local echo */
  setRemoteSession: (isRemote: boolean) => void;
};

/**
 * Mounts xterm onto `container`, spawns a PTY in Rust, wires them bidirectionally.
 * Reloads the same shell for the lifetime of the hook; unmount kills it.
 */
export function usePty(
  container: HTMLDivElement | null,
  shell: string,
  cwd: string,
  skipTabRegistration?: boolean,
): PtyHandle | null {
  const [handle, setHandle] = useState<PtyHandle | null>(null);
  const boundRef = useRef(false);
  const { addTab, removeTab, setCwd } = useTabs();
  const setTerminalCwd = useIacStateStore((s) => s.setTerminalCwd);
  const { addBlock, completeBlock } = useBlocksStore();
  const getPasswordContext = useSshPasswordStore((s) => s.getPasswordContext);
  const clearPasswordContext = useSshPasswordStore((s) => s.clearPasswordContext);

  // Refs for output buffering and block tracking
  const outputBufferRef = useRef<string>('');
  const currentBlockIdRef = useRef<string | null>(null);
  const blockStartTimeRef = useRef<number>(0);
  const lastOutputRef = useRef<string>(''); // Track recent output for password detection
  const passwordSentRef = useRef<boolean>(false); // Prevent password loop
  const inRemoteSessionRef = useRef<boolean>(false); // Track if in SSH/telnet session
  const liveCwdRef = useRef<string>(cwd); // Live cwd, updated by the shell's OSC 7

  useEffect(() => {
    if (!container) return;
    if (boundRef.current) return; // already bound — skip duplicate mount
    boundRef.current = true;

    // Resolve xterm constructors at runtime (CDN may not be loaded at module eval time)
    const XTerm = window.Terminal;
    const FitAddon = window.FitAddon?.FitAddon || window.FitAddon;
    const WebLinksAddon = window.WebLinksAddon?.WebLinksAddon || window.WebLinksAddon;
    const ClipboardAddon = window.ClipboardAddon?.ClipboardAddon || window.ClipboardAddon;

    if (!XTerm || !FitAddon || !WebLinksAddon || !ClipboardAddon) {
      console.error("xterm not loaded from CDN yet");
      boundRef.current = false;
      return;
    }

    const term = new XTerm({
      convertEol: true,
      fontFamily: 'Menlo, "SF Mono", Monaco, monospace',
      fontSize: 13,
      theme: {
        background: "#0f1114",
        foreground: "#e6e1cf",
        cursor: "#5ccfe6",
        cursorAccent: "#000000",
      },
      rightClickSelectsWord: true,
      cursorBlink: true,
      cursorStyle: 'block',
      // Disable local echo - let PTY handle all terminal state
      // This allows the shell's readline to work properly
      allowProposedApi: true,
    });

    const fit = new FitAddon();
    const clipboard = new ClipboardAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.loadAddon(clipboard);
    term.open(container);
    fit.fit();

    let tabId: string | null = null;
    let disposed = false;
    const pendingDisposables: (() => void)[] = [];

    // Windows-Terminal-style copy/paste, mapped onto the keys you'd expect:
    //   • Ctrl+C  → copy when there's a selection; otherwise fall through to the
    //               shell as the SIGINT interrupt (^C) so you can still kill a
    //               runaway ping / traceroute / "show tech".
    //   • Ctrl+V  → always paste the clipboard into the PTY.
    // Returning false from the handler tells xterm to swallow the key (no
    // onData, no default), which is what we want once we've handled it here.
    term.attachCustomKeyEventHandler((e: KeyboardEvent): boolean => {
      if (e.type !== "keydown") return true;
      if (!e.ctrlKey || e.metaKey || e.altKey) return true;

      // Ctrl+C: copy selection if present, else let it pass as interrupt.
      if (e.key === "c" || e.key === "C") {
        const selection = term.getSelection();
        if (selection && selection.length > 0) {
          e.preventDefault();
          navigator.clipboard.writeText(selection).catch((err) => {
            console.error("[usePty] clipboard copy failed:", err);
          });
          return false; // handled — don't send ^C
        }
        return true; // no selection → pass ^C through to the shell (SIGINT)
      }

      // Ctrl+V: paste clipboard contents into the PTY.
      if (e.key === "v" || e.key === "V") {
        e.preventDefault();
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text && tabId) {
              ptyWrite(tabId, new TextEncoder().encode(text)).catch((err) => {
                console.error("[usePty] paste ptyWrite failed:", err);
              });
            }
          })
          .catch((err) => {
            console.error("[usePty] clipboard read failed:", err);
          });
        return false; // handled — don't send ^V
      }

      return true; // every other Ctrl+key behaves normally
    });

    const onEvent = (e: PtyEvent) => {
      if (disposed) return; // component torn down — drop stray late events
      switch (e.type) {
        case "output": {
          const text = new TextDecoder().decode(new Uint8Array(e.bytes));
          term.write(new Uint8Array(e.bytes));

          // Track recent output for password detection and SSH exit detection
          lastOutputRef.current += text;
          if (lastOutputRef.current.length > 500) {
            lastOutputRef.current = lastOutputRef.current.slice(-500);
          }

          // Detect when SSH session ends (back to local prompt)
          if (tabId && inRemoteSessionRef.current) {
            // Look for the exact "Connection to <host> closed" pattern in recent output
            // Use a regex to ensure we match the complete phrase, not fragments
            const sshExitPattern = /Connection to [^\s]+ closed/;

            if (sshExitPattern.test(lastOutputRef.current)) {
              console.log('[usePty] ✓ SSH session ended (detected exit message), re-enabling local echo');
              inRemoteSessionRef.current = false;
              // Clear buffer to prevent re-triggering
              lastOutputRef.current = '';
            }
          }

          // Detect password prompts and auto-fill if we have a stored password
          if (tabId) {
            const lowerOutput = lastOutputRef.current.toLowerCase();
            const hasPasswordPrompt =
              lowerOutput.includes('password:') ||
              lowerOutput.includes("password for") ||
              lowerOutput.includes('password?') ||
              lowerOutput.match(/\bpassword\s*[:?]/);

            if (hasPasswordPrompt && !passwordSentRef.current) {
              const context = getPasswordContext(tabId);
              if (context) {
                console.log('[usePty] ✓ SENDING PASSWORD');
                passwordSentRef.current = true;
                const encoder = new TextEncoder();
                const passwordBytes = encoder.encode(context.password + '\n');

                // Auto-send password
                setTimeout(() => {
                  ptyWrite(tabId!, passwordBytes).then(() => {
                    // Clear password context IMMEDIATELY to prevent re-use
                    clearPasswordContext(tabId!);
                    // Clear the output buffer to prevent re-triggering on stale "password:" text
                    lastOutputRef.current = '';
                    // Reset flag after short delay (long enough to ignore echo, short enough to catch retry prompts)
                    setTimeout(() => {
                      passwordSentRef.current = false;
                    }, 2000);
                  }).catch((err) => {
                    console.error('[usePty] Failed to auto-fill password:', err);
                    passwordSentRef.current = false;
                  });
                }, 100); // Small delay to ensure prompt is ready
              }
            }
          }

          // Buffer output for current block
          if (currentBlockIdRef.current) {
            outputBufferRef.current += text;
          }
          break;
        }
        case "cwd":
          // Shell reported its working directory (OSC 7). Track it live so the
          // state-browser drawer and new command blocks use where the user
          // actually is, not the tab's spawn directory. NOTE: `tabId` here is
          // the backend PTY/terminal id (panes spawn PTYs under their own id,
          // not the frontend tab id), so we key the cwd map by it.
          liveCwdRef.current = e.path;
          if (tabId) {
            setTerminalCwd(tabId, e.path);
            setCwd(tabId, e.path); // also updates single-pane tabs where ids match
          }
          break;
        case "command_start":
          if (tabId) {
            // Start new block (use the live cwd, not the stale spawn cwd)
            const blockId = addBlock(tabId, e.cmd, liveCwdRef.current);
            currentBlockIdRef.current = blockId;
            blockStartTimeRef.current = Date.now();
            outputBufferRef.current = '';

          }
          break;
        case "command_end":
          if (currentBlockIdRef.current) {
            // Complete current block - strip ANSI codes from output
            const duration = Date.now() - blockStartTimeRef.current;
            const cleanOutput = stripAnsi(outputBufferRef.current);
            completeBlock(
              currentBlockIdRef.current,
              e.exit_code ?? -1,
              duration,
              cleanOutput
            );

            currentBlockIdRef.current = null;
            outputBufferRef.current = '';
          }
          break;
        case "exit":
          if (tabId) removeTab(tabId);
          break;
      }
    };

    ptySpawn({
      shell,
      args: [], // No args needed - PTY provides interactive terminal interface
      cwd,
      cols: term.cols,
      rows: term.rows,
      onEvent,
    }).then((id) => {
      if (disposed) return;
      tabId = id;

      // Only add tab if not skipping registration (for split panes)
      if (!skipTabRegistration) {
        addTab({
          id,
          title: shell.split("/").pop() ?? shell,
          shell_cmd: shell,
          cwd,
          created_at: Date.now() / 1000,
          tab_type: 'terminal',
        });
      }

      // Handle user input from xterm (for Terminal mode)
      const d1 = term.onData((data: string) => {
        // By default we do NO local echo: the PTY/TTY line discipline and the
        // shell's own line editor render the line. This is required for Tab
        // completion / history / reverse-search to work. The old behavior
        // (JS-side echo, gated on remote sessions) is preserved behind the
        // ENABLE_LOCAL_ECHO revert switch above.
        if (ENABLE_LOCAL_ECHO) {
          const charCode = data.charCodeAt(0);
          // Only echo locally if we're NOT in a remote session (SSH/telnet/etc).
          // Remote servers handle their own echo, so local echo double-prints.
          const inRemote = inRemoteSessionRef.current;
          if (!inRemote) {
            // Handle multi-character input (paste) by echoing the entire string
            if (data.length > 1) {
              term.write(data);
            } else if (charCode === 127 || charCode === 8) {
              term.write('\b \b');
            } else if (charCode === 13) {
              term.write('\r\n');
            } else if (charCode >= 32 && charCode <= 126) {
              term.write(data);
            }
          }
        }

        // Send to PTY
        const encoder = new TextEncoder();
        const bytes = encoder.encode(data);
        ptyWrite(id, bytes).catch((err) => {
          console.error('[usePty] ptyWrite failed:', err);
        });
      });

      // TODO: Re-enable special commands (/, #) later
      // For now just basic terminal input/output

      const d2 = term.onResize(({ cols, rows }: { cols: number; rows: number }) => {
        ptyResize(id, cols, rows).catch(console.error);
      });
      pendingDisposables.push(() => d1.dispose(), () => d2.dispose());

      setHandle({
        term,
        tabId: id,
        fit: () => fit.fit(),
        dispose: () => {
          disposed = true;
          pendingDisposables.forEach((d) => d());
          term.dispose();
        },
        setRemoteSession: (isRemote: boolean) => {
          console.log('[usePty] setRemoteSession called with:', isRemote);
          inRemoteSessionRef.current = isRemote;
        },
      });
    }).catch((err) => {
      console.error("ptySpawn failed", err);
    });

    return () => {
      disposed = true;
      pendingDisposables.forEach((d) => d());
      term.dispose();
      boundRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [container, shell, cwd]);

  return handle;
}
