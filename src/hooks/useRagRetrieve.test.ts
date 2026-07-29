import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

vi.mock("../lib/rag", () => ({
  ragRetrieve: vi.fn(),
}));

import { ragRetrieve } from "../lib/rag";
import { useRagRetrieve } from "./useRagRetrieve";

const mockRagRetrieve = ragRetrieve as unknown as ReturnType<typeof vi.fn>;

describe("useRagRetrieve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts in idle state with empty results", () => {
    const { result } = renderHook(() => useRagRetrieve());
    expect(result.current.results).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("populates results after a successful retrieve", async () => {
    const fixture = [
      {
        chunk_id: 1,
        document_id: 2,
        document_title: "doc",
        chunk_idx: 0,
        text: "hello",
        distance: 0.1,
        tags: ["generic"] as const,
      },
    ];
    mockRagRetrieve.mockResolvedValueOnce(fixture);

    const { result } = renderHook(() => useRagRetrieve());

    await act(async () => {
      await result.current.retrieve({
        query: "anything",
        tags: ["cisco-iosxe-router"],
        k: 3,
      });
    });

    expect(result.current.results).toEqual(fixture);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockRagRetrieve).toHaveBeenCalledWith({
      query: "anything",
      tags: ["cisco-iosxe-router"],
      k: 3,
    });
  });

  it("surfaces error and resets loading when retrieve rejects", async () => {
    mockRagRetrieve.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useRagRetrieve());

    await act(async () => {
      await expect(
        result.current.retrieve({ query: "x", tags: [], k: 1 }),
      ).rejects.toThrow("boom");
    });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("boom");
  });

  it("flips loading=true while the request is in flight", async () => {
    let resolveFn: ((v: unknown[]) => void) | null = null;
    mockRagRetrieve.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFn = resolve; }),
    );

    const { result } = renderHook(() => useRagRetrieve());

    let p: Promise<unknown> | null = null;
    act(() => {
      p = result.current.retrieve({ query: "x", tags: [], k: 1 });
    });

    await waitFor(() => expect(result.current.loading).toBe(true));

    await act(async () => {
      resolveFn?.([]);
      await p;
    });

    expect(result.current.loading).toBe(false);
  });
});
