import { renderHook, waitFor, act } from "@testing-library/react";
import { vi, describe, it, expect, beforeEach } from "vitest";

const getStructuredMock = vi.fn();
vi.mock("../lib/structured", () => ({
  getStructured: (...args: unknown[]) => getStructuredMock(...args),
}));

import { useStructuredOutput } from "./useStructuredOutput";

describe("useStructuredOutput", () => {
  beforeEach(() => {
    getStructuredMock.mockReset();
  });

  it("loads parsed output for a block", async () => {
    getStructuredMock.mockResolvedValue({
      blockId: "b1",
      parser: "textfsm",
      command: "show ip int br",
      vendor: "cisco",
      platform: "iosxe",
      data: [{ intf: "Gi1" }],
      createdAt: 0,
    });
    const { result } = renderHook(() => useStructuredOutput("b1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.parsed?.parser).toBe("textfsm");
    expect(result.current.error).toBeNull();
  });

  it("sets parsed=null when blockId is null", async () => {
    const { result } = renderHook(() => useStructuredOutput(null));
    expect(result.current.parsed).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("captures errors from the underlying call", async () => {
    getStructuredMock.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useStructuredOutput("b1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toContain("boom");
  });

  it("refresh re-fetches the parsed output", async () => {
    getStructuredMock.mockResolvedValue({
      blockId: "b1",
      parser: "genie",
      command: "show version",
      vendor: "cisco",
      platform: "iosxe",
      data: { hostname: "R1" },
      createdAt: 0,
    });
    const { result } = renderHook(() => useStructuredOutput("b1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(getStructuredMock).toHaveBeenCalledTimes(1);
    act(() => result.current.refresh());
    await waitFor(() => expect(getStructuredMock).toHaveBeenCalledTimes(2));
  });
});
