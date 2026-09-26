import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { toCsv, toJson, toMarkdownTable, copyToClipboard, downloadFile } from "./export";

const saveMock = vi.fn();
const writeTextFileMock = vi.fn();
const clipboardWriteTextMock = vi.fn();
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: (...a: unknown[]) => saveMock(...a) }));
vi.mock("@tauri-apps/plugin-fs", () => ({
  writeTextFile: (...a: unknown[]) => writeTextFileMock(...a),
}));
vi.mock("@tauri-apps/plugin-clipboard-manager", () => ({
  writeText: (...a: unknown[]) => clipboardWriteTextMock(...a),
}));

describe("toCsv", () => {
  it("emits header + rows including embedded commas / quotes", () => {
    const csv = toCsv(
      [
        { a: 1, b: "hello, world" },
        { a: 2, b: 'has "quotes"' },
      ],
      ["a", "b"],
    );
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("a,b");
    expect(lines[1]).toBe('1,"hello, world"');
    expect(lines[2]).toBe('2,"has ""quotes"""');
  });

  it("respects column order even when row keys are out of order", () => {
    const csv = toCsv(
      [{ b: "second", a: "first" }],
      ["a", "b"],
    );
    expect(csv.startsWith("a,b\r\nfirst,second")).toBe(true);
  });
});

describe("toJson", () => {
  it("emits pretty-printed JSON", () => {
    const json = toJson([{ x: 1 }, { x: 2 }]);
    expect(json).toContain("\n");
    expect(JSON.parse(json)).toEqual([{ x: 1 }, { x: 2 }]);
  });
});

describe("toMarkdownTable", () => {
  it("emits a GFM-compatible table with aligned pipes", () => {
    const md = toMarkdownTable(
      [
        { col1: "a", col2: "b" },
        { col1: "c", col2: "d" },
      ],
      ["col1", "col2"],
    );
    const lines = md.split("\n");
    expect(lines[0]).toBe("| col1 | col2 |");
    expect(lines[1]).toBe("| --- | --- |");
    expect(lines[2]).toBe("| a | b |");
    expect(lines[3]).toBe("| c | d |");
  });

  it("escapes pipes in cell values", () => {
    const md = toMarkdownTable([{ x: "foo|bar" }], ["x"]);
    expect(md).toContain("foo\\|bar");
  });

  it("returns empty string for no columns", () => {
    expect(toMarkdownTable([], [])).toBe("");
  });
});

describe("copyToClipboard", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    clipboardWriteTextMock.mockReset();
  });

  it("calls navigator.clipboard.writeText in a plain browser", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    await copyToClipboard("hello");
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(clipboardWriteTextMock).not.toHaveBeenCalled();
  });

  it("routes through the Tauri clipboard-manager plugin inside Tauri", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const webWriteText = vi.fn(async () => undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: webWriteText },
    });
    clipboardWriteTextMock.mockResolvedValue(undefined);

    await copyToClipboard("via-tauri");

    expect(clipboardWriteTextMock).toHaveBeenCalledWith("via-tauri");
    expect(webWriteText).not.toHaveBeenCalled();
  });
});

describe("downloadFile", () => {
  beforeEach(() => {
    saveMock.mockReset();
    writeTextFileMock.mockReset();
  });
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("routes through the Tauri save dialog + fs when inside Tauri", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    saveMock.mockResolvedValue("$HOME/out.csv");
    writeTextFileMock.mockResolvedValue(undefined);

    const ok = await downloadFile("show-ip-route.csv", "a,b\n1,2", "text/csv");

    expect(ok).toBe(true);
    expect(saveMock).toHaveBeenCalledWith(
      expect.objectContaining({ defaultPath: "show-ip-route.csv" }),
    );
    expect(writeTextFileMock).toHaveBeenCalledWith("$HOME/out.csv", "a,b\n1,2");
  });

  it("returns false and writes nothing when the user cancels the Tauri dialog", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    saveMock.mockResolvedValue(null);

    const ok = await downloadFile("out.json", "{}", "application/json");

    expect(ok).toBe(false);
    expect(writeTextFileMock).not.toHaveBeenCalled();
  });

  it("falls back to a blob-anchor download in a plain browser", async () => {
    const clickSpy = vi.fn();
    const origCreate = document.createElement.bind(document);
    const createSpy = vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      const el = origCreate(tag);
      if (tag === "a") el.click = clickSpy;
      return el as HTMLElement;
    });
    // jsdom has no createObjectURL/revokeObjectURL by default.
    (URL as unknown as Record<string, unknown>).createObjectURL = vi.fn(() => "blob:x");
    (URL as unknown as Record<string, unknown>).revokeObjectURL = vi.fn();

    const ok = await downloadFile("out.csv", "a,b", "text/csv");

    expect(ok).toBe(true);
    expect(clickSpy).toHaveBeenCalled();
    expect(saveMock).not.toHaveBeenCalled();
    createSpy.mockRestore();
  });
});
