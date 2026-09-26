import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  importRunnableNotebookMarkdown,
  exportRunnableNotebookMarkdown,
  listRunnableNotebooks,
  getRunnableNotebook,
  deleteRunnableNotebook,
  downloadRunnableNotebook,
} from "./runnableNotebook";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

describe("runnableNotebook wrappers", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("import returns the new id", async () => {
    mocks.invoke.mockResolvedValueOnce("nb-abc");
    const id = await importRunnableNotebookMarkdown("---\ntitle: t\n---\n");
    expect(id).toBe("nb-abc");
    expect(mocks.invoke).toHaveBeenCalledWith("notebook_import_markdown", {
      markdown: "---\ntitle: t\n---\n",
    });
  });

  it("export returns markdown", async () => {
    mocks.invoke.mockResolvedValueOnce("---\ntitle: t\n---\nbody");
    const md = await exportRunnableNotebookMarkdown("nb-abc");
    expect(md).toContain("title: t");
    expect(mocks.invoke).toHaveBeenCalledWith("notebook_export_markdown", { id: "nb-abc" });
  });

  it("list passes vendor + limit through", async () => {
    mocks.invoke.mockResolvedValueOnce([]);
    await listRunnableNotebooks("cisco", 50);
    expect(mocks.invoke).toHaveBeenCalledWith("notebook_list_runnable", {
      vendor: "cisco",
      limit: 50,
    });
  });

  it("list with no args sends nulls", async () => {
    mocks.invoke.mockResolvedValueOnce([]);
    await listRunnableNotebooks();
    expect(mocks.invoke).toHaveBeenCalledWith("notebook_list_runnable", {
      vendor: null,
      limit: null,
    });
  });

  it("get + delete delegate to invoke", async () => {
    mocks.invoke
      .mockResolvedValueOnce({ id: "nb-x", frontmatter: { title: "t" }, cells: [] })
      .mockResolvedValueOnce(undefined);
    const got = await getRunnableNotebook("nb-x");
    expect(got.id).toBe("nb-x");
    await deleteRunnableNotebook("nb-x");
    expect(mocks.invoke).toHaveBeenLastCalledWith("notebook_delete_runnable", { id: "nb-x" });
  });

  it("downloadRunnableNotebook is a no-op outside the browser", () => {
    expect(() => downloadRunnableNotebook("foo", "body")).not.toThrow();
  });

  it("downloadRunnableNotebook appends .mop.md when missing", () => {
    const origCreate = globalThis.document?.createElement;
    if (!origCreate) return; // jsdom not available — skip
    const a: any = { click: vi.fn(), remove: vi.fn() };
    const create = vi.spyOn(globalThis.document, "createElement").mockReturnValue(a);
    const append = vi.spyOn(globalThis.document.body, "appendChild").mockImplementation((n: any) => n);
    downloadRunnableNotebook("foo", "body");
    expect(a.download).toBe("foo.mop.md");
    create.mockRestore();
    append.mockRestore();
  });
});
