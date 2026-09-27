import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  changeRunPreSsh,
  changeRunPostSsh,
  changeRunPostAndReportSsh,
} from "./changeVerify";

describe("changeVerify SSH-direct wrappers", () => {
  beforeEach(() => invokeMock.mockReset());

  it("changeRunPreSsh forwards connection id + password", async () => {
    invokeMock.mockResolvedValue({ id: "snap1" });
    await changeRunPreSsh("tab1", "conn1", "bundle1", "cisco", "iosxe", "pw");
    expect(invokeMock).toHaveBeenCalledWith("change_run_pre_ssh", {
      tabId: "tab1",
      connectionId: "conn1",
      bundleId: "bundle1",
      vendor: "cisco",
      platform: "iosxe",
      password: "pw",
    });
  });

  it("changeRunPostSsh works without an explicit password", async () => {
    invokeMock.mockResolvedValue({ id: "snap2" });
    await changeRunPostSsh("tab1", "conn1", "bundle1", "cisco", "iosxe");
    expect(invokeMock).toHaveBeenCalledWith("change_run_post_ssh", {
      tabId: "tab1",
      connectionId: "conn1",
      bundleId: "bundle1",
      vendor: "cisco",
      platform: "iosxe",
      password: undefined,
    });
  });

  it("changeRunPostAndReportSsh forwards the full report payload", async () => {
    invokeMock.mockResolvedValue(["report1", { counts: { red: 0, yellow: 0, green: 1 } }, 1]);
    const deltas = [{ command_substring: "show", path_substring: "x", note: "ok" }];
    await changeRunPostAndReportSsh(
      "tab1", "conn1", "bundle1", "cisco", "iosxe", "pre1", deltas, "note", "pw",
    );
    expect(invokeMock).toHaveBeenCalledWith("change_run_post_and_report_ssh", {
      tabId: "tab1",
      connectionId: "conn1",
      bundleId: "bundle1",
      vendor: "cisco",
      platform: "iosxe",
      preSnapshotId: "pre1",
      approvedDeltas: deltas,
      notes: "note",
      password: "pw",
    });
  });
});
