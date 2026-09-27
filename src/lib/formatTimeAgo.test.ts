import { describe, it, expect } from "vitest";
import { formatTimeAgo } from "./formatTimeAgo";

describe("formatTimeAgo", () => {
  const NOW = 1_700_000_000;

  it("formats seconds", () => {
    expect(formatTimeAgo(NOW - 30, NOW)).toBe("30s ago");
    expect(formatTimeAgo(NOW - 0, NOW)).toBe("0s ago");
    expect(formatTimeAgo(NOW - 59, NOW)).toBe("59s ago");
  });

  it("formats minutes", () => {
    expect(formatTimeAgo(NOW - 60, NOW)).toBe("1m ago");
    expect(formatTimeAgo(NOW - 90, NOW)).toBe("1m ago");
    expect(formatTimeAgo(NOW - 60 * 30, NOW)).toBe("30m ago");
  });

  it("formats hours", () => {
    expect(formatTimeAgo(NOW - 3600, NOW)).toBe("1h ago");
    expect(formatTimeAgo(NOW - 3600 * 5, NOW)).toBe("5h ago");
  });

  it("formats days", () => {
    expect(formatTimeAgo(NOW - 86400, NOW)).toBe("1d ago");
    expect(formatTimeAgo(NOW - 86400 * 2, NOW)).toBe("2d ago");
    expect(formatTimeAgo(NOW - 86400 * 6, NOW)).toBe("6d ago");
  });

  it("formats weeks", () => {
    expect(formatTimeAgo(NOW - 604800, NOW)).toBe("1w ago");
    expect(formatTimeAgo(NOW - 604800 * 3, NOW)).toBe("3w ago");
  });

  it("formats months", () => {
    expect(formatTimeAgo(NOW - 2_592_000, NOW)).toBe("1mo ago");
    expect(formatTimeAgo(NOW - 2_592_000 * 6, NOW)).toBe("6mo ago");
  });

  it("formats years", () => {
    expect(formatTimeAgo(NOW - 31_536_000, NOW)).toBe("1y ago");
    expect(formatTimeAgo(NOW - 31_536_000 * 3, NOW)).toBe("3y ago");
  });

  it("handles future timestamps as 0s ago", () => {
    expect(formatTimeAgo(NOW + 60, NOW)).toBe("0s ago");
  });
});
