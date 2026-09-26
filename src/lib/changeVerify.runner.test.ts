import { describe, it, expect, vi } from "vitest";
import { changeRunPre, changeRunPost, changeSnapshotGet, changeLatestPreForTab, changeRunPostAndReport, changeReportList } from "./changeVerify";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: any) => {
    if (cmd === "change_run_pre" || cmd === "change_run_post") {
      return {
        id: cmd === "change_run_pre" ? "pre1" : "post1",
        tab_id: args.tabId,
        bundle_id: args.bundleId,
        label: cmd === "change_run_pre" ? "pre" : "post",
        captured_at: 1,
        results: [{ command: "show version", parsed_output_id: 42 }],
      };
    }
    if (cmd === "change_snapshot_get") {
      return { id: args.id, tab_id: "t", bundle_id: "b", label: "pre", captured_at: 1, results: [] };
    }
    if (cmd === "change_latest_pre_for_tab") return "pre1";
    if (cmd === "change_run_post_and_report") {
      return ["rpt1", {
        pre_snapshot_id: args.preSnapshotId,
        post_snapshot_id: "post1",
        bundle_id: args.bundleId,
        counts: { red: 1, yellow: 0, green: 0 },
        deltas: [],
        matched_approved: [],
        notes: args.notes,
      }, 1715000000];
    }
    if (cmd === "change_report_list") {
      return [["rpt1", 1, "p", "q"]];
    }
    throw new Error("unexpected command " + cmd);
  }),
}));

describe("changeVerify runner client", () => {
  it("changeRunPre passes vendor/platform through", async () => {
    const snap = await changeRunPre("t1", "b1", "cisco", "iosxe");
    expect(snap.id).toBe("pre1");
    expect(snap.label).toBe("pre");
    expect(snap.tab_id).toBe("t1");
    expect(snap.bundle_id).toBe("b1");
  });
  it("changeRunPost returns label=post", async () => {
    const snap = await changeRunPost("t1", "b1", "cisco", "iosxe");
    expect(snap.label).toBe("post");
  });
  it("changeSnapshotGet round-trips id", async () => {
    const snap = await changeSnapshotGet("pre1");
    expect(snap.id).toBe("pre1");
  });
  it("changeLatestPreForTab returns id or null", async () => {
    expect(await changeLatestPreForTab("t1", "b1")).toBe("pre1");
  });
  it("changeRunPostAndReport returns [id, summary, createdAt]", async () => {
    const [id, summary, createdAt] = await changeRunPostAndReport("t", "b", "cisco", "iosxe", "p", [], null);
    expect(id).toBe("rpt1");
    expect(summary.counts.red).toBe(1);
    expect(createdAt).toBe(1715000000);
  });
  it("changeReportList returns rows", async () => {
    const rows = await changeReportList();
    expect(rows[0][0]).toBe("rpt1");
  });
});
