import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { makeDebouncedSaver } from "./useSessionSave";

describe("makeDebouncedSaver", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("coalesces rapid calls into one save with the latest args", () => {
    const save = vi.fn();
    const saver = makeDebouncedSaver(save, 1000);
    saver("a", ["a1"]);
    saver("b", ["b1"]);
    saver("c", ["c1", "c2"]);
    expect(save).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith("c", ["c1", "c2"]);
  });

  it("flush() saves immediately with the pending args", () => {
    const save = vi.fn();
    const saver = makeDebouncedSaver(save, 1000);
    saver("x", ["x1"]);
    saver.flush();
    expect(save).toHaveBeenCalledWith("x", ["x1"]);
    vi.advanceTimersByTime(1000);
    expect(save).toHaveBeenCalledTimes(1); // not double-fired
  });
});
