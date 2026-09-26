import { describe, it, expect, beforeEach, vi } from "vitest";
import { useChangeVerifyStore } from "./changeVerifyStore";
import * as api from "../lib/changeVerify";

vi.mock("../lib/changeVerify");

describe("changeVerifyStore", () => {
  beforeEach(() => {
    useChangeVerifyStore.setState({
      bundles: [],
      selectedBundleId: null,
      loading: false,
      error: null,
      preSnapshot: null,
      currentReport: null,
      reports: [],
    });
    vi.clearAllMocks();
  });

  it("loadBundles populates state", async () => {
    vi.mocked(api.bundleList).mockResolvedValue([
      { id: "b1", name: "n", description: null, vendor: "cisco", platform: "iosxe",
        commands: ["show version"], created_at: 1, updated_at: 1 },
    ]);
    await useChangeVerifyStore.getState().loadBundles();
    const s = useChangeVerifyStore.getState();
    expect(s.bundles).toHaveLength(1);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it("loadBundles sets error on failure", async () => {
    vi.mocked(api.bundleList).mockRejectedValue(new Error("boom"));
    await useChangeVerifyStore.getState().loadBundles();
    const s = useChangeVerifyStore.getState();
    expect(s.error).toContain("boom");
    expect(s.loading).toBe(false);
  });

  it("createBundle prepends to bundles", async () => {
    const created = { id: "new", name: "x", description: null, vendor: "cisco",
      platform: "iosxe", commands: [], created_at: 2, updated_at: 2 };
    vi.mocked(api.bundleCreate).mockResolvedValue(created);
    useChangeVerifyStore.setState({
      bundles: [{ id: "old", name: "y", description: null, vendor: "cisco",
        platform: "iosxe", commands: [], created_at: 1, updated_at: 1 }],
    });
    await useChangeVerifyStore.getState().createBundle({
      name: "x", description: null, vendor: "cisco", platform: "iosxe", commands: [],
    });
    expect(useChangeVerifyStore.getState().bundles[0].id).toBe("new");
    expect(useChangeVerifyStore.getState().bundles[1].id).toBe("old");
  });

  it("deleteBundle removes from bundles without re-fetch", async () => {
    vi.mocked(api.bundleDelete).mockResolvedValue();
    useChangeVerifyStore.setState({
      bundles: [
        { id: "keep", name: "k", description: null, vendor: "cisco", platform: "iosxe", commands: [], created_at: 1, updated_at: 1 },
        { id: "drop", name: "d", description: null, vendor: "cisco", platform: "iosxe", commands: [], created_at: 1, updated_at: 1 },
      ],
    });
    await useChangeVerifyStore.getState().deleteBundle("drop");
    const ids = useChangeVerifyStore.getState().bundles.map(b => b.id);
    expect(ids).toEqual(["keep"]);
    expect(api.bundleList).not.toHaveBeenCalled();
  });

  it("selectBundle sets selectedBundleId", () => {
    useChangeVerifyStore.getState().selectBundle("xyz");
    expect(useChangeVerifyStore.getState().selectedBundleId).toBe("xyz");
    useChangeVerifyStore.getState().selectBundle(null);
    expect(useChangeVerifyStore.getState().selectedBundleId).toBeNull();
  });

  it("runPreCheck sets preSnapshot", async () => {
    vi.mocked(api.changeRunPre).mockResolvedValue({
      id: "pre1", tab_id: "t1", bundle_id: "b1", label: "pre",
      captured_at: 1, results: [],
    });
    await useChangeVerifyStore.getState().runPreCheck("t1", "b1", "cisco", "iosxe");
    expect(useChangeVerifyStore.getState().preSnapshot?.id).toBe("pre1");
  });

  it("runPostCheck sets currentReport with createdAt", async () => {
    vi.mocked(api.changeRunPostAndReport).mockResolvedValue(["rpt1", {
      pre_snapshot_id: "pre1", post_snapshot_id: "post1", bundle_id: "b1",
      counts: { red: 1, yellow: 0, green: 0 },
      deltas: [], matched_approved: [], notes: null,
    }, 1715000000]);
    const result = await useChangeVerifyStore.getState().runPostCheck(
      "t1", "b1", "cisco", "iosxe", "pre1"
    );
    expect(result.id).toBe("rpt1");
    expect(result.summary.counts.red).toBe(1);
    const currentReport = useChangeVerifyStore.getState().currentReport;
    expect(currentReport?.id).toBe("rpt1");
    expect(currentReport?.createdAt).toBe(1715000000);
  });

  it("clearSnapshots resets pre and currentReport", () => {
    useChangeVerifyStore.setState({
      preSnapshot: { id: "p", tab_id: "t", bundle_id: "b", label: "pre", captured_at: 1, results: [] },
      currentReport: {
        id: "rpt1",
        summary: {
          pre_snapshot_id: "p", post_snapshot_id: "q", bundle_id: "b",
          counts: { red: 0, yellow: 0, green: 0 },
          deltas: [], matched_approved: [], notes: null,
        },
        approved: [],
        createdAt: 1715000000,
      },
    });
    useChangeVerifyStore.getState().clearSnapshots();
    const s = useChangeVerifyStore.getState();
    expect(s.preSnapshot).toBeNull();
    expect(s.currentReport).toBeNull();
  });

  it("appendApproval preserves createdAt", async () => {
    vi.mocked(api.changeReportAppendApproval).mockResolvedValue([{
      pre_snapshot_id: "pre1", post_snapshot_id: "post1", bundle_id: "b1",
      counts: { red: 0, yellow: 0, green: 1 },
      deltas: [], matched_approved: [], notes: null,
    }, [{
      command_substring: "bgp", path_substring: "10.0.0.2", note: "approved",
    }]]);
    useChangeVerifyStore.setState({
      currentReport: {
        id: "rpt1",
        summary: {
          pre_snapshot_id: "pre1", post_snapshot_id: "post1", bundle_id: "b1",
          counts: { red: 1, yellow: 0, green: 0 },
          deltas: [], matched_approved: [], notes: null,
        },
        approved: [],
        createdAt: 1715000000,
      },
    });
    await useChangeVerifyStore.getState().appendApproval("rpt1", {
      command_substring: "bgp", path_substring: "10.0.0.2", note: "approved",
    });
    const currentReport = useChangeVerifyStore.getState().currentReport;
    expect(currentReport?.createdAt).toBe(1715000000); // Preserved!
    expect(currentReport?.approved).toHaveLength(1);
  });
});
