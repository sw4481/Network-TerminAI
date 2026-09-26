import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("announces textual device status and progress without relying on color", () => {
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
              status: "failed",
              attempt: 1,
              progressBytes: 0,
              errorMessage: "timeout",
            },
          },
        },
      },
      selectedRunId: "r1",
      selectedTab: "merged",
    });

    render(<FanoutPanel />);

    expect(screen.getByTestId("fanout-row-ssh-d1")).toHaveTextContent("running");
    expect(screen.getByTestId("fanout-row-ssh-d2")).toHaveTextContent("failed");
    const running = screen.getByRole("progressbar", { name: "r1-atl progress" });
    const failed = screen.getByRole("progressbar", { name: "r2-atl progress" });
    expect(running).toHaveAttribute("aria-valuetext", "running");
    expect(running).not.toHaveAttribute("aria-valuenow");
    expect(failed).toHaveAttribute("aria-valuetext", "failed");
    expect(failed).toHaveAttribute("aria-valuenow", "100");
  });

  it("uses readable semantic foregrounds for fan-out status chips and progress fills", () => {
    const css = readFileSync(resolve("src/components/FanoutPanel.css"), "utf8");

    expect(css).toMatch(
      /\.fanout-status-chip\.running\s*\{[^}]*background:[^;}]+;[^}]*color:\s*var\(--status-success\)/,
    );
    expect(css).toMatch(
      /\.fanout-status-chip\.success\s*\{[^}]*background:[^;}]+;[^}]*color:\s*var\(--status-success\)/,
    );
    expect(css).toMatch(
      /\.fanout-status-chip\.failed\s*\{[^}]*background:\s*var\(--status-danger-surface\);[^}]*color:\s*var\(--status-danger\)/,
    );
    expect(css).toMatch(
      /\.fanout-progress-bar\s*>\s*div\s*\{[^}]*background:\s*var\(--status-info\)/,
    );
    expect(css).toMatch(
      /\.fanout-progress-bar\.failed\s*>\s*div\s*\{[^}]*background:\s*var\(--status-danger\)/,
    );
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
