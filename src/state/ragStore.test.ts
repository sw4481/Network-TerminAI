import { describe, expect, it, beforeEach, vi } from "vitest";
import { useRagStore } from "./ragStore";

vi.mock("../lib/rag", () => ({
  ragList: vi.fn().mockResolvedValue([]),
  ragTaxonomy: vi
    .fn()
    .mockResolvedValue({ builtin: ["generic"], user: [] }),
  onUploadProgress: vi.fn(),
}));

describe("ragStore active user tags", () => {
  beforeEach(() => {
    useRagStore.getState().reset();
  });

  it("getActiveUserTags returns [] for an unknown tab", () => {
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([]);
  });

  it("setActiveUserTags overwrites the per-tab list", () => {
    useRagStore.getState().setActiveUserTags("tab-x", ["customer-acme"]);
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([
      "customer-acme",
    ]);
    useRagStore.getState().setActiveUserTags("tab-x", []);
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([]);
  });

  it("toggleActiveUserTag adds and removes per-tab", () => {
    useRagStore.getState().toggleActiveUserTag("tab-x", "customer-acme");
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([
      "customer-acme",
    ]);
    useRagStore.getState().toggleActiveUserTag("tab-x", "cli-only");
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([
      "customer-acme",
      "cli-only",
    ]);
    useRagStore.getState().toggleActiveUserTag("tab-x", "customer-acme");
    expect(useRagStore.getState().getActiveUserTags("tab-x")).toEqual([
      "cli-only",
    ]);
  });

  it("per-tab state is independent", () => {
    useRagStore.getState().toggleActiveUserTag("tab-a", "customer-acme");
    useRagStore.getState().toggleActiveUserTag("tab-b", "project1");
    expect(useRagStore.getState().getActiveUserTags("tab-a")).toEqual([
      "customer-acme",
    ]);
    expect(useRagStore.getState().getActiveUserTags("tab-b")).toEqual([
      "project1",
    ]);
  });
});
