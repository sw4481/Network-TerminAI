import { describe, it, expect, vi } from "vitest";
import {
  paletteSearch,
  paletteRecordUse,
  parseCategoryPrefix,
  iconForKind,
  labelForKind,
  type PaletteHit,
} from "./palette";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: Record<string, unknown>) => {
    if (cmd === "palette_search") {
      // Echo the args back so the test can assert the wire shape.
      return [
        {
          kind: "block",
          target_id: "b1",
          title: "show ip bgp",
          subtitle: "tab-1",
          score: 0.9,
          recency_boost: 0,
          frequency_boost: 0,
          meta: { echoed: args },
        },
      ] satisfies PaletteHit[];
    }
    if (cmd === "palette_record_use") return null;
    return null;
  }),
}));

describe("palette wrapper", () => {
  it("invokes palette_search with the snake_case args shape", async () => {
    const hits = await paletteSearch({
      query: "bgp",
      scope: "tab",
      activeTabId: "tab-1",
      activeDeviceId: null,
      kindFilter: "block",
      limit: 20,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("block");
    const echoed = (hits[0].meta as { echoed: { payload: { args: Record<string, unknown> } } })
      .echoed;
    expect(echoed.payload.args).toEqual({
      query: "bgp",
      scope: "tab",
      active_tab_id: "tab-1",
      active_device_id: null,
      kind_filter: "block",
      limit: 20,
    });
  });

  it("nulls absent active ids and kindFilter", async () => {
    const hits = await paletteSearch({
      query: "show",
      scope: "global",
      limit: 10,
    });
    const echoed = (hits[0].meta as { echoed: { payload: { args: Record<string, unknown> } } })
      .echoed;
    expect(echoed.payload.args.active_tab_id).toBeNull();
    expect(echoed.payload.args.active_device_id).toBeNull();
    expect(echoed.payload.args.kind_filter).toBeNull();
  });

  it("records a pick", async () => {
    await expect(paletteRecordUse("block", "b1")).resolves.toBeUndefined();
  });
});

describe("parseCategoryPrefix", () => {
  it("returns no filter when query has no > prefix", () => {
    expect(parseCategoryPrefix("show ip")).toEqual({
      kindFilter: null,
      searchText: "show ip",
    });
  });

  it("maps each single-letter prefix to the right kind", () => {
    expect(parseCategoryPrefix(">c bgp").kindFilter).toBe("command");
    expect(parseCategoryPrefix(">w").kindFilter).toBe("workflow");
    expect(parseCategoryPrefix(">n notes").kindFilter).toBe("notebook");
    expect(parseCategoryPrefix(">d core").kindFilter).toBe("device");
    expect(parseCategoryPrefix(">b").kindFilter).toBe("block");
    expect(parseCategoryPrefix(">s edge").kindFilter).toBe("ssh");
  });

  it("strips the prefix from the residual text", () => {
    expect(parseCategoryPrefix(">w bgp audit")).toEqual({
      kindFilter: "workflow",
      searchText: "bgp audit",
    });
  });

  it("treats unknown prefix as literal text (fall through)", () => {
    expect(parseCategoryPrefix(">z foo")).toEqual({
      kindFilter: null,
      searchText: ">z foo",
    });
  });

  it("returns empty searchText when only > is typed", () => {
    expect(parseCategoryPrefix(">")).toEqual({
      kindFilter: null,
      searchText: "",
    });
  });

  it("is case insensitive on the prefix letter", () => {
    expect(parseCategoryPrefix(">W").kindFilter).toBe("workflow");
  });
});

describe("kind labels and icons", () => {
  it("returns a glyph for every kind", () => {
    for (const k of [
      "command",
      "workflow",
      "notebook",
      "device",
      "block",
      "ssh",
    ] as const) {
      expect(iconForKind(k)).toBeTruthy();
      expect(labelForKind(k)).toBeTruthy();
    }
  });
});
