import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { apiCommitPostmanImport, apiPreviewPostmanImport } from "./tauri";

describe("Postman import Tauri wrappers", () => {
  beforeEach(() => invokeMock.mockReset().mockResolvedValue(undefined));

  it("uses camel-case argument names expected by Tauri", async () => {
    await apiPreviewPostmanImport("/tmp/source.json");
    await apiCommitPostmanImport("/tmp/source.json", "fingerprint");
    expect(invokeMock.mock.calls).toEqual([
      ["api_preview_postman_import", { sourcePath: "/tmp/source.json" }],
      ["api_commit_postman_import", {
        sourcePath: "/tmp/source.json",
        fingerprint: "fingerprint",
      }],
    ]);
  });
});
