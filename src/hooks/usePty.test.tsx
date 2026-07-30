import { render, waitFor } from "@testing-library/react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAppearanceSettings } from "../theme/defaults";
import type { AppearanceSettingsV1 } from "../theme/types";

const ptySpawn = vi.fn(async () => "legacy-pty");
const ptyResize = vi.fn(async () => undefined);
const appearance = vi.hoisted(() => ({ settings: null as unknown as AppearanceSettingsV1 }));

vi.mock("../lib/tauri", () => ({
  ptySpawn: (args: unknown) => ptySpawn(args),
  ptyWrite: vi.fn(async () => undefined),
  ptyResize: (id: string, cols: number, rows: number) => ptyResize(id, cols, rows),
}));
vi.mock("../theme/AppearanceProvider", () => ({ useAppearance: () => appearance }));
vi.mock("../state/tabsStore", () => ({ useTabs: () => ({ addTab: vi.fn(), removeTab: vi.fn(), setCwd: vi.fn() }) }));
vi.mock("../state/iacStateStore", () => ({ useIacStateStore: (selector: (state: { setTerminalCwd: () => void }) => unknown) => selector({ setTerminalCwd: vi.fn() }) }));
vi.mock("../state/blocksStore", () => ({ useBlocksStore: () => ({ addBlock: vi.fn(), completeBlock: vi.fn() }) }));
vi.mock("../state/sshPasswordStore", () => ({ useSshPasswordStore: (selector: (state: { getPasswordContext: () => null; clearPasswordContext: () => void }) => unknown) => selector({ getPasswordContext: () => null, clearPasswordContext: vi.fn() }) }));

import { usePty } from "./usePty";

function installXterm() {
  const terminals: Array<{ options: Record<string, unknown>; refresh: ReturnType<typeof vi.fn>; cols: number; rows: number }> = [];
  (window as any).Terminal = class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown>;
    open = vi.fn(); loadAddon = vi.fn(); write = vi.fn(); dispose = vi.fn();
    refresh = vi.fn(); onData = vi.fn(() => ({ dispose: vi.fn() }));
    onResize = vi.fn(() => ({ dispose: vi.fn() })); attachCustomKeyEventHandler = vi.fn(); getSelection = vi.fn(() => "");
    constructor(options: Record<string, unknown>) { this.options = options; terminals.push(this); }
  };
  (window as any).FitAddon = { FitAddon: class { fit = vi.fn(); } };
  (window as any).WebLinksAddon = { WebLinksAddon: class {} };
  (window as any).ClipboardAddon = { ClipboardAddon: class {} };
  return terminals;
}

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
});
