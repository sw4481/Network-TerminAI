import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { FanoutPanel } from "./FanoutPanel";
import { useFanoutStore } from "../state/fanoutStore";
import { useFanoutRunsStore } from "../state/fanoutRunsStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

beforeEach(() => {
  useFanoutStore.setState({
    groups: [],
    membersByGroup: {},
    loading: false,
    error: null,
  });
  useFanoutRunsStore.setState({
    activeRunsById: {},
    selectedRunId: null,
    selectedTab: "merged",
  });
});

describe("FanoutPanel", () => {
  it("renders the command bar with disabled Run when no group is selected", () => {
    render(<FanoutPanel />);
    expect(screen.getByTestId("fanout-panel")).toBeInTheDocument();
    expect(screen.getByTestId("fanout-run")).toBeDisabled();
  });

  it("renders progress lane and tabs when an active run is present", () => {
    useFanoutRunsStore.setState({
      activeRunsById: {
        r1: {
          runId: "r1",
          command: "show ver",
          groupId: null,
          startedAt: 0,
          status: "running",
          totalDevices: 2,
          devices: {
            "ssh:d1": {
              deviceId: "d1",
              deviceKind: "ssh",
              displayName: "r1-atl",
              status: "running",
              attempt: 1,
              progressBytes: 0,
            },
            "ssh:d2": {
              deviceId: "d2",
              deviceKind: "ssh",
              displayName: "r2-atl",
              status: "success",
              attempt: 1,
              progressBytes: 0,
              blockId: "b2",
            },
          },
        },
      },
      selectedRunId: "r1",
      selectedTab: "merged",
    });
    render(<FanoutPanel />);
    expect(screen.getByTestId("fanout-tab-merged")).toBeInTheDocument();
    expect(screen.getByTestId("fanout-row-ssh-d1")).toBeInTheDocument();
    expect(screen.getByTestId("fanout-row-ssh-d2")).toBeInTheDocument();
    // Cancel All button shows while running
    expect(screen.getByText("Cancel All")).toBeInTheDocument();
  });

  it("shows export and retry buttons after a run finishes", () => {
    useFanoutRunsStore.setState({
      activeRunsById: {
        r1: {
          runId: "r1",
          command: "show",
          groupId: null,
          startedAt: 0,
          endedAt: 1,
          status: "partial",
          totalDevices: 1,
          devices: {
            "ssh:d1": {
              deviceId: "d1",
              deviceKind: "ssh",
              displayName: "r1",
              status: "failed",
              attempt: 1,
              progressBytes: 0,
              errorMessage: "boom",
            },
          },
        },
      },
      selectedRunId: "r1",
      selectedTab: "merged",
    });
    render(<FanoutPanel />);
    expect(screen.getByText("Retry Failed")).toBeInTheDocument();
    expect(screen.getByText("Export Zip")).toBeInTheDocument();
  });
});
