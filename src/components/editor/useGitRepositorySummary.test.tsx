import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRepositorySummary } from "../../lib/tauri";
import { useGitRepositorySummary } from "./useGitRepositorySummary";

const cleanSummary: GitRepositorySummary = {
  repoRoot: "/repo",
  branch: "main",
  headOid: "abcdef0123456789",
  dirty: false,
  changedFiles: 0,
  stagedFiles: 0,
  unstagedFiles: 0,
  untrackedFiles: 0,
};

describe("useGitRepositorySummary", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads immediately and refreshes on focus and interval", async () => {
    const loader = vi.fn().mockResolvedValue(cleanSummary);
    const { result } = renderHook(() =>
      useGitRepositorySummary("/repo", true, loader),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(result.current.summary).toEqual(cleanSummary);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(loader).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(loader).toHaveBeenCalledTimes(3);
  });

  it("does not poll when disabled", async () => {
    const loader = vi.fn().mockResolvedValue(cleanSummary);
    const { result } = renderHook(() =>
      useGitRepositorySummary("/repo", false, loader),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(loader).not.toHaveBeenCalled();
    expect(result.current.summary).toBeNull();
  });

  it("ignores a stale response after the path changes", async () => {
    let resolveOld: ((value: GitRepositorySummary | null) => void) | null = null;
    const oldRequest = new Promise<GitRepositorySummary | null>((resolve) => {
      resolveOld = resolve;
    });
    const loader = vi
      .fn()
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce({ ...cleanSummary, branch: "next" });
    const { result, rerender } = renderHook(
      ({ path }) => useGitRepositorySummary(path, true, loader),
      { initialProps: { path: "/old" } },
    );

    rerender({ path: "/next" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.summary?.branch).toBe("next");

    await act(async () => {
      resolveOld?.({ ...cleanSummary, branch: "stale" });
      await Promise.resolve();
    });
    expect(result.current.summary?.branch).toBe("next");
  });
});
