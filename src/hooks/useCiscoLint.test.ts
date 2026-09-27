import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifyResponse } from "../lib/guardrails";
import { classifyCommand } from "../lib/guardrails";
import { useCiscoLint } from "./useCiscoLint";

vi.mock("../lib/guardrails", () => ({
  classifyCommand: vi.fn(),
}));

const classifyCommandMock = vi.mocked(classifyCommand);

describe("useCiscoLint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    classifyCommandMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns structural diagnostics immediately and classifies every non-empty line after debounce", async () => {
    classifyCommandMock
      .mockResolvedValueOnce({
        tier: "T0",
        rule_id: null,
        reasoning: "Read-only",
      })
      .mockResolvedValueOnce({
        tier: "T2",
        rule_id: "save-config",
        reasoning: "Writes startup config",
      });

    const { result } = renderHook(() =>
      useCiscoLint({
        content: "!\nshow version\ncopy running-config startup-config",
        platform: "iosxe",
        debounceMs: 10,
      }),
    );

    expect(result.current.guardrails.state).toBe("idle");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.guardrails.state).toBe("ready");
    expect(result.current.structuralStatus).toBe("ready");
    expect(classifyCommandMock).toHaveBeenNthCalledWith(
      2,
      "cisco",
      "iosxe",
      "copy running-config startup-config",
    );
    expect(result.current.diagnostics).toEqual([
      expect.objectContaining({ code: "guardrail-save-config", line: 3 }),
    ]);
  });

  it("keeps structural findings and reports unavailable on classifier failure", async () => {
    classifyCommandMock.mockRejectedValue(new Error("local classifier unavailable"));
    const { result } = renderHook(() =>
      useCiscoLint({
        content: "Router#show version",
        platform: "nxos",
        debounceMs: 10,
      }),
    );

    expect(result.current.diagnostics).toEqual([
      expect.objectContaining({ code: "cli-prompt" }),
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.guardrails.state).toBe("unavailable");
    expect(result.current.diagnostics).toEqual([
      expect.objectContaining({ code: "cli-prompt" }),
    ]);
    expect(result.current.guardrails.reason).toContain(
      "local classifier unavailable",
    );
  });

  it("discards a stale classifier result after content changes", async () => {
    let resolveFirst!: (value: ClassifyResponse) => void;
    const first = new Promise<ClassifyResponse>((resolve) => {
      resolveFirst = resolve;
    });
    classifyCommandMock.mockReturnValueOnce(first).mockResolvedValue({
      tier: "T0",
      rule_id: null,
      reasoning: "Read-only",
    });

    const { result, rerender } = renderHook(
      ({ content }) =>
        useCiscoLint({ content, platform: "iosxe", debounceMs: 10 }),
      { initialProps: { content: "copy running-config startup-config" } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    rerender({ content: "show version" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(result.current.guardrails.state).toBe("ready");
    await act(async () => {
      resolveFirst({ tier: "T3", rule_id: "stale", reasoning: "stale" });
      await first;
    });

    expect(result.current.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "guardrail-stale" }),
    );
  });

  it("limits concurrent classifier IPC calls", async () => {
    const resolvers: Array<(value: ClassifyResponse) => void> = [];
    let active = 0;
    let peak = 0;
    classifyCommandMock.mockImplementation(
      () =>
        new Promise<ClassifyResponse>((resolve) => {
          active += 1;
          peak = Math.max(peak, active);
          resolvers.push((value) => {
            active -= 1;
            resolve(value);
          });
        }),
    );
    const content = Array.from({ length: 9 }, (_, index) => `show line-${index + 1}`).join(
      "\n",
    );
    const { result } = renderHook(() =>
      useCiscoLint({ content, platform: "iosxe", debounceMs: 10 }),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(classifyCommandMock).toHaveBeenCalledTimes(4);
    expect(peak).toBe(4);

    await act(async () => {
      resolvers.splice(0, 4).forEach((resolve) =>
        resolve({ tier: "T0", rule_id: null, reasoning: "Read-only" }),
      );
      await Promise.resolve();
    });
    expect(classifyCommandMock).toHaveBeenCalledTimes(8);
    expect(peak).toBe(4);

    await act(async () => {
      resolvers.splice(0, 4).forEach((resolve) =>
        resolve({ tier: "T0", rule_id: null, reasoning: "Read-only" }),
      );
      await Promise.resolve();
    });
    expect(classifyCommandMock).toHaveBeenCalledTimes(9);
    expect(peak).toBe(4);

    await act(async () => {
      resolvers[0]({ tier: "T0", rule_id: null, reasoning: "Read-only" });
      await Promise.resolve();
    });
    expect(result.current.guardrails.state).toBe("ready");
  });

  it("stops scheduling stale classifier batches", async () => {
    const oldResolvers: Array<(value: ClassifyResponse) => void> = [];
    classifyCommandMock.mockImplementation((_vendor, _platform, command) => {
      if (command.startsWith("old ")) {
        return new Promise<ClassifyResponse>((resolve) => oldResolvers.push(resolve));
      }
      return Promise.resolve({ tier: "T0", rule_id: null, reasoning: "Read-only" });
    });
    const oldContent = Array.from({ length: 8 }, (_, index) => `old ${index + 1}`).join(
      "\n",
    );
    const { rerender } = renderHook(
      ({ content }) => useCiscoLint({ content, platform: "iosxe", debounceMs: 10 }),
      { initialProps: { content: oldContent } },
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(classifyCommandMock).toHaveBeenCalledTimes(4);

    rerender({ content: "show version" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    await act(async () => {
      oldResolvers.forEach((resolve) =>
        resolve({ tier: "T0", rule_id: null, reasoning: "Read-only" }),
      );
      await Promise.resolve();
    });

    expect(classifyCommandMock).toHaveBeenCalledWith(
      "cisco",
      "iosxe",
      "show version",
    );
    expect(classifyCommandMock).not.toHaveBeenCalledWith("cisco", "iosxe", "old 5");
  });

  it("stays idle when no Cisco platform is active", () => {
    const { result } = renderHook(() =>
      useCiscoLint({ content: "Router#show version", platform: null }),
    );

    expect(result.current).toEqual({
      diagnostics: [],
      structuralStatus: "ready",
      guardrails: { state: "idle", reason: null },
    });
    expect(classifyCommandMock).not.toHaveBeenCalled();
  });
});
