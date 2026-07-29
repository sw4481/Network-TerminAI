import { describe, it, expect, beforeEach, vi, type Mock } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  ragUpload,
  ragList,
  ragDelete,
  ragTaxonomy,
  onUploadProgress,
  ragRetrieve,
  type RetrievedChunk,
  TAG_SHAPE_RE,
  isReservedPrefix,
} from "./rag";

describe("rag.ts wrappers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ragUpload forwards args under the `args` key and returns the doc_id", async () => {
    (invoke as unknown as Mock).mockResolvedValueOnce(42);
    const id = await ragUpload({
      path: "/tmp/x.md",
      kind: "md",
      title: "Test",
      tags: ["generic"],
    });
    expect(id).toBe(42);
    expect(invoke).toHaveBeenCalledWith("rag_upload", {
      args: {
        path: "/tmp/x.md",
        kind: "md",
        title: "Test",
        tags: ["generic"],
      },
    });
  });

  it("ragList invokes rag_list_documents with no args", async () => {
    (invoke as unknown as Mock).mockResolvedValueOnce([]);
    const docs = await ragList();
    expect(docs).toEqual([]);
    expect(invoke).toHaveBeenCalledWith("rag_list_documents");
  });

  it("ragDelete passes camelCase docId", async () => {
    (invoke as unknown as Mock).mockResolvedValueOnce(undefined);
    await ragDelete(7);
    expect(invoke).toHaveBeenCalledWith("rag_delete_document", { docId: 7 });
  });

  it("ragTaxonomy returns the static taxonomy list", async () => {
    const taxonomy = { builtin: ["cisco-iosxe-router", "generic"], user: [] };
    (invoke as unknown as Mock).mockResolvedValueOnce(taxonomy);
    const out = await ragTaxonomy();
    expect(out).toEqual(taxonomy);
    expect(invoke).toHaveBeenCalledWith("rag_tag_taxonomy");
  });

  it("ragRetrieve forwards args under the `args` key and returns RetrievedChunk[]", async () => {
    const fixture: RetrievedChunk[] = [
      {
        chunk_id: 7,
        document_id: 3,
        document_title: "IOS-XE Reference",
        chunk_idx: 0,
        text: "BGP neighbor configuration",
        distance: 0.12,
        tags: ["cisco-iosxe-router"],
      },
    ];
    (invoke as unknown as Mock).mockResolvedValueOnce(fixture);
    const out = await ragRetrieve({
      query: "BGP",
      tags: ["cisco-iosxe-router"],
      k: 3,
    });
    expect(out).toEqual(fixture);
    expect(invoke).toHaveBeenCalledWith("rag_retrieve", {
      args: {
        query: "BGP",
        tags: ["cisco-iosxe-router"],
        k: 3,
      },
    });
  });

  it("onUploadProgress subscribes to rag://upload-progress and unwraps payload", async () => {
    const unlisten = vi.fn();
    let captured: ((e: { payload: unknown }) => void) | null = null;
    (listen as unknown as Mock).mockImplementationOnce(
      async (_name: string, cb: (e: { payload: unknown }) => void) => {
        captured = cb;
        return unlisten;
      },
    );

    const cb = vi.fn();
    const unl = await onUploadProgress(cb);

    expect(listen).toHaveBeenCalledWith(
      "rag://upload-progress",
      expect.any(Function),
    );
    // simulate a backend event
    expect(captured).not.toBeNull();
    (captured as unknown as (e: { payload: unknown }) => void)({
      payload: {
        docPath: "/tmp/x.md",
        phase: "embedding",
        chunksDone: 1,
        chunksTotal: 4,
      },
    });
    expect(cb).toHaveBeenCalledWith({
      docPath: "/tmp/x.md",
      phase: "embedding",
      chunksDone: 1,
      chunksTotal: 4,
    });
    expect(unl).toBe(unlisten);
  });
});

describe("TAG_SHAPE_RE", () => {
  it("accepts user slugs", () => {
    expect(TAG_SHAPE_RE.test("customer-acme")).toBe(true);
    expect(TAG_SHAPE_RE.test("a")).toBe(true);
    expect(TAG_SHAPE_RE.test("0")).toBe(true);
    expect(TAG_SHAPE_RE.test("a".repeat(32))).toBe(true);
    expect(TAG_SHAPE_RE.test("project1")).toBe(true);
  });
  it("rejects bad shapes", () => {
    expect(TAG_SHAPE_RE.test("")).toBe(false);
    expect(TAG_SHAPE_RE.test("Customer-ACME")).toBe(false);
    expect(TAG_SHAPE_RE.test("-leading")).toBe(false);
    expect(TAG_SHAPE_RE.test("bad space")).toBe(false);
    expect(TAG_SHAPE_RE.test("a".repeat(33))).toBe(false);
  });
  it("permits trailing and consecutive hyphens (matches Rust)", () => {
    // Documenting intentional parity with Rust validate_tag_shape, which
    // also accepts these. Tighten in both layers if that ever changes.
    expect(TAG_SHAPE_RE.test("foo-")).toBe(true);
    expect(TAG_SHAPE_RE.test("foo--bar")).toBe(true);
  });
});

describe("isReservedPrefix", () => {
  it("flags vendor prefixes for non-builtin tags", () => {
    expect(isReservedPrefix("cisco-foo")).toBe(true);
    expect(isReservedPrefix("juniper-x")).toBe(true);
    expect(isReservedPrefix("arista-foo")).toBe(true);
  });
  it("permits builtins themselves", () => {
    expect(isReservedPrefix("cisco-iosxe-router")).toBe(false);
    expect(isReservedPrefix("juniper-junos")).toBe(false);
  });
  it("permits ordinary user tags", () => {
    expect(isReservedPrefix("customer-acme")).toBe(false);
  });
});
