import { render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAppearanceSettings } from "../theme/defaults";
import type { AppearanceSettingsV1 } from "../theme/types";

const ptySpawn = vi.fn(async () => "legacy-pty");
const ptyResize = vi.fn(async () => undefined);
const ptyWrite = vi.fn(async (_id?: string, _bytes?: Uint8Array) => undefined);
const appearance = vi.hoisted(() => ({ settings: null as unknown as AppearanceSettingsV1 }));

vi.mock("../lib/tauri", () => ({
  ptySpawn: (args: unknown) => ptySpawn(args),
  ptyWrite: (id: string, bytes: Uint8Array) => ptyWrite(id, bytes),
  ptyResize: (id: string, cols: number, rows: number) => ptyResize(id, cols, rows),
}));
vi.mock("../theme/AppearanceProvider", () => ({ useAppearance: () => appearance }));
vi.mock("../state/tabsStore", () => ({ useTabs: () => ({ addTab: vi.fn(), removeTab: vi.fn(), setCwd: vi.fn() }) }));
vi.mock("../state/iacStateStore", () => ({ useIacStateStore: (selector: (state: { setTerminalCwd: () => void }) => unknown) => selector({ setTerminalCwd: vi.fn() }) }));
vi.mock("../state/blocksStore", () => ({ useBlocksStore: () => ({ addBlock: vi.fn(), completeBlock: vi.fn() }) }));
vi.mock("../state/sshPasswordStore", () => ({ useSshPasswordStore: (selector: (state: { getPasswordContext: () => null; clearPasswordContext: () => void }) => unknown) => selector({ getPasswordContext: () => null, clearPasswordContext: vi.fn() }) }));

import { usePty } from "./usePty";
import { useTerminalConnectionStore } from "../state/terminalConnectionStore";

function installXterm() {
  const terminals: Array<{ options: Record<string, unknown>; refresh: ReturnType<typeof vi.fn>; cols: number; rows: number }> = [];
  searchAddons.length = 0;
  (window as any).Terminal = class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    loadedAddons: any[] = [];
    open = vi.fn();
    loadAddon = vi.fn((addon: any) => this.loadedAddons.push(addon));
    buffer = {
      active: {
        baseY: 0,
        viewportY: 0,
        cursorY: 0,
        getLine: vi.fn(() => ({ translateToString: () => "connected" })),
      },
    };
    registerMarker = vi.fn(() => ({ dispose: vi.fn(), onDispose: vi.fn() }));
    registerDecoration = vi.fn(() => ({ dispose: vi.fn(), onRender: vi.fn() }));
    write = vi.fn((_data: unknown, callback?: () => void) => callback?.());
    dispose = vi.fn(() => this.loadedAddons.forEach((addon) => addon.dispose?.()));
    refresh = vi.fn(); onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() })); attachCustomKeyEventHandler = vi.fn(); getSelection = vi.fn(() => "");
    constructor(options: Record<string, unknown>) { this.options = options; terminals.push(this); }
  };
  (window as any).FitAddon = { FitAddon: class { fit = vi.fn(); } };
  (window as any).WebLinksAddon = { WebLinksAddon: class {} };
  (window as any).ClipboardAddon = { ClipboardAddon: class {} };
  (window as any).SearchAddon = {
    SearchAddon: class {
      findNext = vi.fn(() => true);
      findPrevious = vi.fn(() => true);
      clearDecorations = vi.fn();
      onDidChangeResults = vi.fn(() => ({ dispose: vi.fn() }));
      dispose = vi.fn();
      constructor() { searchAddons.push(this); }
    },
  };
  return terminals;
}

const searchAddons: any[] = [];

function Harness() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  usePty(container, "/bin/zsh", "/tmp", true);
  return <div ref={setContainer} />;
}

describe("usePty legacy appearance updates", () => {
  beforeEach(() => {
    appearance.settings = createDefaultAppearanceSettings();
    ptySpawn.mockClear();
    ptyResize.mockClear();
    ptyWrite.mockClear();
    useTerminalConnectionStore.setState({ byTerminalId: {}, terminalIdByBackendPtyId: {} });
  });

  it("updates the same legacy xterm and PTY when appearance settings change", async () => {
    const terminals = installXterm();
    const view = render(<Harness />);
    await waitFor(() => expect(terminals).toHaveLength(1));
    await waitFor(() => expect(ptySpawn).toHaveBeenCalledTimes(1));
    const terminal = terminals[0];

    appearance.settings = {
      ...appearance.settings,
      terminal: { ...appearance.settings.terminal, preset: "custom", fontSize: 18, foreground: "#ABCDEF" },
    };
    view.rerender(<Harness />);

    await waitFor(() => expect(terminal.options).toMatchObject({ fontSize: 18, theme: { foreground: "#ABCDEF" } }));
    expect(terminals).toHaveLength(1);
    expect(ptySpawn).toHaveBeenCalledTimes(1);
    expect(ptyResize).toHaveBeenCalledWith("legacy-pty", terminal.cols, terminal.rows);
  });

  it("loads one search addon and disposes it with the fallback xterm", async () => {
    installXterm();
    const view = render(<Harness />);
    await waitFor(() => expect(searchAddons).toHaveLength(1));
    const addon = searchAddons[0];
    view.unmount();
    expect(addon.dispose).toHaveBeenCalledTimes(1);
  });

  it("uses the shared Linux Ctrl+Shift paste policy in the fallback handler", async () => {
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('Linux x86_64');
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: vi.fn(async () => 'show clock'),
        writeText: vi.fn(async () => undefined),
      },
    });
    const terminals = installXterm();
    render(<Harness />);
    await waitFor(() => expect(ptySpawn).toHaveBeenCalledTimes(1));
    const terminal = terminals[0] as any;
    const handler = terminal.attachCustomKeyEventHandler.mock.calls[0][0];
    expect(handler({
      type: 'keydown',
      key: 'V',
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
      altKey: false,
      preventDefault: vi.fn(),
    })).toBe(false);
    await waitFor(() => expect(ptyWrite).toHaveBeenCalledTimes(1));
    expect(ptyWrite.mock.calls[0][0]).toBe('legacy-pty');
    expect(new TextDecoder().decode(ptyWrite.mock.calls[0][1])).toBe('show clock');
    platform.mockRestore();
  });

  it("wires output and alternate-screen events through the presentation highlighter", async () => {
    const terminals = installXterm();
    render(<Harness />);
    await waitFor(() => expect(ptySpawn).toHaveBeenCalledTimes(1));
    const terminal = terminals[0] as any;
    useTerminalConnectionStore.getState().bind({
      terminalId: "legacy-pty",
      backendPtyId: "legacy-pty",
      connectionId: "connection-1",
      displayName: "Core",
      vendor: "cisco",
      platform: "iosxe",
      accentColor: null,
      syntaxHighlightingEnabled: true,
      syntaxProfile: "auto",
      sshCommand: "ssh core",
    });
    terminal.registerDecoration.mockClear();
    const onEvent = ptySpawn.mock.calls[0][0].onEvent as (event: unknown) => void;
    const bytes = Array.from(new TextEncoder().encode("connected"));

    onEvent({ type: "output", bytes });
    expect(terminal.registerDecoration).toHaveBeenCalled();
    onEvent({ type: "enter_alt_screen" });
    terminal.registerDecoration.mockClear();
    onEvent({ type: "output", bytes });
    expect(terminal.registerDecoration).not.toHaveBeenCalled();
    onEvent({ type: "exit_alt_screen" });
    onEvent({ type: "output", bytes });
    expect(terminal.registerDecoration).toHaveBeenCalled();

    onEvent({ type: "command_start", cmd: "ssh core" });
    expect(useTerminalConnectionStore.getState().get("legacy-pty")?.lifecycle).toBe("connected");
    onEvent({ type: "command_end", exit_code: 0 });
    expect(useTerminalConnectionStore.getState().get("legacy-pty")?.lifecycle).toBe("disconnected");
  });
});
