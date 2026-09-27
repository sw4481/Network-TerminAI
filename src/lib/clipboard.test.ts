import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { copyWithAutoClear, _resetClipboardState } from "./clipboard";

describe("copyWithAutoClear", () => {
  let clipboard: { value: string; writes: string[] };
  let writeText: ReturnType<typeof vi.fn>;
  let readText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    _resetClipboardState();
    clipboard = { value: "", writes: [] };
    writeText = vi.fn(async (s: string) => {
      clipboard.value = s;
      clipboard.writes.push(s);
    });
    readText = vi.fn(async () => clipboard.value);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText, readText },
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    _resetClipboardState();
  });

  it("writes text to clipboard immediately", async () => {
    await copyWithAutoClear("hello", 1000);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(clipboard.value).toBe("hello");
  });

  it("clears clipboard after ttl when content unchanged", async () => {
    await copyWithAutoClear("secret", 1000);
    expect(clipboard.value).toBe("secret");
    await vi.advanceTimersByTimeAsync(1100);
    expect(clipboard.value).not.toBe("secret");
    expect(writeText).toHaveBeenCalledTimes(2); // initial + clear
  });

  it("does NOT overwrite if user copied something else", async () => {
    await copyWithAutoClear("vault-pw", 1000);
    clipboard.value = "user-typed-something-new";
    await vi.advanceTimersByTimeAsync(1100);
    expect(clipboard.value).toBe("user-typed-something-new");
  });

  it("only the latest timer survives when called twice", async () => {
    await copyWithAutoClear("first", 1000);
    await vi.advanceTimersByTimeAsync(500);
    await copyWithAutoClear("second", 1000);
    await vi.advanceTimersByTimeAsync(600);
    // First timer would have fired at 1000ms, but was canceled.
    expect(clipboard.value).toBe("second");
    await vi.advanceTimersByTimeAsync(500);
    expect(clipboard.value).not.toBe("second"); // cleared
  });
});
