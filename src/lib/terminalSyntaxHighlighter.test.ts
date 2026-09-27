import { describe, expect, it, vi } from "vitest";
import {
  findSyntaxMatches,
  TerminalSyntaxHighlighter,
  writeTerminalOutput,
} from "./terminalSyntaxHighlighter";
import { resolveSyntaxProfile } from "./deviceProfiles";

function fakeTerminal(lines: string[]) {
  const decorations: Array<{ options: Record<string, unknown>; dispose: ReturnType<typeof vi.fn> }> = [];
  const terminal: any = {
    rows: 24,
    buffer: {
      active: {
        baseY: 0,
        viewportY: 0,
        cursorY: 0,
        getLine: (index: number) => ({ translateToString: () => lines[index] ?? "" }),
      },
    },
    registerMarker: vi.fn(() => ({ dispose: vi.fn(), onDispose: vi.fn() })),
    registerDecoration: vi.fn((options) => {
      const decoration = { options, dispose: vi.fn(), onRender: vi.fn() };
      decorations.push(decoration);
      return decoration;
    }),
    write: vi.fn((_data, callback) => callback?.()),
  };
  return { terminal, decorations };
}

const ciscoSettings = () => ({
  enabled: true,
  profile: "auto" as const,
  vendor: "cisco" as const,
  platform: "iosxe",
});

describe("terminal syntax profile matching", () => {
  it("resolves auto from saved vendor/platform and keeps Meraki generic", () => {
    expect(resolveSyntaxProfile("auto", "juniper", "generic")).toBe("junos");
    expect(resolveSyntaxProfile("auto", "generic", "eos")).toBe("arista");
    expect(resolveSyntaxProfile("auto", "meraki", "generic")).toBe("generic");
  });

  it("selects ordered, case-insensitive literals and avoids shorter overlaps", () => {
    const matches = findSyntaxMatches("Gi1 is Administratively DOWN, not downlink", "cisco");
    expect(matches.map((match) => match.phrase.toLowerCase())).toEqual(["administratively down"]);
  });

  it("honors word boundaries and caps matches per line", () => {
    expect(findSyntaxMatches("backup upper connected", "generic").map((match) => match.phrase))
      .toEqual(["connected"]);
    expect(findSyntaxMatches("up up up", "generic", 2)).toHaveLength(2);
  });
});

describe("TerminalSyntaxHighlighter", () => {
  it("rescans a rewritten current line and disposes its old decorations", () => {
    const lines = ["Gi1 up"];
    const { terminal, decorations } = fakeTerminal(lines);
    const highlighter = new TerminalSyntaxHighlighter(terminal, ciscoSettings);
    writeTerminalOutput(terminal, highlighter, new Uint8Array([117, 112]));
    const first = decorations[0];
    lines[0] = "Gi1 administratively down";
    writeTerminalOutput(terminal, highlighter, "\rGi1 administratively down");
    expect(first.dispose).toHaveBeenCalledOnce();
    expect(terminal.registerDecoration).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 4, width: "administratively down".length }),
    );
  });

  it("suspends and clears decorations for alternate screen output", () => {
    const { terminal, decorations } = fakeTerminal(["connected"]);
    const highlighter = new TerminalSyntaxHighlighter(terminal, ciscoSettings);
    writeTerminalOutput(terminal, highlighter, "connected");
    highlighter.enterAlternateScreen();
    expect(decorations[0].dispose).toHaveBeenCalledOnce();
    writeTerminalOutput(terminal, highlighter, "error");
    expect(terminal.registerDecoration).toHaveBeenCalledTimes(1);
    highlighter.exitAlternateScreen();
    writeTerminalOutput(terminal, highlighter, "error");
    expect(terminal.registerDecoration).toHaveBeenCalledTimes(2);
  });

  it("passes the original output bytes through unchanged", () => {
    const { terminal } = fakeTerminal(["up"]);
    const highlighter = new TerminalSyntaxHighlighter(terminal, ciscoSettings);
    const bytes = new Uint8Array([0, 27, 91, 109, 255]);
    writeTerminalOutput(terminal, highlighter, bytes);
    expect(terminal.write.mock.calls[0][0]).toBe(bytes);
  });

  it("disables itself nonfatally when decoration APIs are unavailable", () => {
    const { terminal } = fakeTerminal(["up"]);
    delete terminal.registerDecoration;
    const highlighter = new TerminalSyntaxHighlighter(terminal, ciscoSettings);
    expect(() => writeTerminalOutput(terminal, highlighter, "up")).not.toThrow();
    expect(terminal.write).toHaveBeenCalledOnce();
  });
});
