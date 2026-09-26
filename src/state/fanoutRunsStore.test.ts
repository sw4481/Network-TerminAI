import { describe, it, expect, beforeEach } from "vitest";
import { useFanoutRunsStore } from "./fanoutRunsStore";

beforeEach(() => {
  useFanoutRunsStore.setState({
    activeRunsById: {},
    selectedRunId: null,
    selectedTab: "merged",
  });
});

describe("fanoutRunsStore.applyEvent", () => {
  it("applies a happy-path stream", () => {
    const { applyEvent } = useFanoutRunsStore.getState();
    applyEvent({
      kind: "run_started",
      run_id: "r1",
      total: 2,
      command: "show",
      group_id: null,
    });
    applyEvent({
      kind: "device_queued",
      run_id: "r1",
      device_id: "d1",
      device_kind: "ssh",
      display_name: "r1-atl",
      attempt: 1,
    });
    applyEvent({
      kind: "device_queued",
      run_id: "r1",
      device_id: "d2",
      device_kind: "ssh",
      display_name: "r2-atl",
      attempt: 1,
    });
    applyEvent({
      kind: "device_started",
      run_id: "r1",
      device_id: "d1",
      device_kind: "ssh",
      attempt: 1,
    });
    applyEvent({
      kind: "device_succeeded",
      run_id: "r1",
      device_id: "d1",
      device_kind: "ssh",
      attempt: 1,
      block_id: "b1",
      parsed_output_id: null,
      duration_ms: 100,
    });
    applyEvent({
      kind: "device_failed",
      run_id: "r1",
      device_id: "d2",
      device_kind: "ssh",
      attempt: 1,
      error: "boom",
      duration_ms: 50,
      failure_kind: "auth",
    });
    applyEvent({
      kind: "run_completed",
      run_id: "r1",
      succeeded: 1,
      failed: 1,
      cancelled: 0,
      duration_ms: 100,
    });
    const run = useFanoutRunsStore.getState().activeRunsById["r1"];
    expect(run.status).toBe("partial");
    expect(run.devices["ssh:d1"].status).toBe("success");
    expect(run.devices["ssh:d1"].blockId).toBe("b1");
    expect(run.devices["ssh:d2"].status).toBe("failed");
    expect(run.devices["ssh:d2"].failureKind).toBe("auth");
  });

  it("ignores out-of-order events (device_succeeded before run_started)", () => {
    const { applyEvent } = useFanoutRunsStore.getState();
    applyEvent({
      kind: "device_succeeded",
      run_id: "ghost",
      device_id: "d1",
      device_kind: "ssh",
      attempt: 1,
      block_id: "b1",
      parsed_output_id: null,
      duration_ms: 1,
    });
    expect(
      Object.keys(useFanoutRunsStore.getState().activeRunsById).length,
    ).toBe(0);
  });

  it("classifies a timeout failure separately from a generic failure", () => {
    const { applyEvent } = useFanoutRunsStore.getState();
    applyEvent({
      kind: "run_started",
      run_id: "r1",
      total: 1,
      command: "show",
      group_id: null,
    });
    applyEvent({
      kind: "device_queued",
      run_id: "r1",
      device_id: "d1",
      device_kind: "ssh",
      display_name: "r1",
      attempt: 1,
    });
    applyEvent({
      kind: "device_failed",
      run_id: "r1",
      device_id: "d1",
      device_kind: "ssh",
      attempt: 1,
      error: "timed out",
      duration_ms: 1000,
      failure_kind: "timeout",
    });
    expect(
      useFanoutRunsStore.getState().activeRunsById["r1"].devices["ssh:d1"]
        .status,
    ).toBe("timeout");
  });

  it("auto-selects first run when none was selected", () => {
    const { applyEvent } = useFanoutRunsStore.getState();
    applyEvent({
      kind: "run_started",
      run_id: "r1",
      total: 0,
      command: "show",
      group_id: null,
    });
    expect(useFanoutRunsStore.getState().selectedRunId).toBe("r1");
  });
});
