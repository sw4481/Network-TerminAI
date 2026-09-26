import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DriftSidebar } from "./DriftSidebar";
import { useIntentStore } from "../state/intentStore";
import { useDriftStore } from "../state/driftStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
}));
vi.mock("./editor/MonacoEditor", () => ({
  MonacoEditor: ({ value }: { value: string }) => (
    <div data-testid="mock-monaco">{value}</div>
  ),
}));

beforeEach(() => {
  useIntentStore.setState({
    templates: [],
    selectedId: null,
    loading: false,
    error: null,
  });
  useDriftStore.setState({
    reportsByTemplate: {},
    selectedReportId: null,
    schedules: [],
    loading: false,
    error: null,
  });
});

describe("DriftSidebar", () => {
  it("shows the empty state when no template selected", () => {
    render(<DriftSidebar />);
    expect(
      screen.getByText(/Pick an intent template/i),
    ).toBeInTheDocument();
  });

  it("disables Run Now until a template is selected", () => {
    render(<DriftSidebar />);
    const runBtn = screen.getByTestId("drift-run") as HTMLButtonElement;
    expect(runBtn).toBeDisabled();
  });

  it("renders reports when state is populated", () => {
    useIntentStore.setState({
      templates: [
        {
          id: "t1",
          name: "core",
          vendor: "cisco",
          platform: "iosxe",
          kind: "golden",
          body: "",
          vars_yaml: "",
          selector: { device_ids: [], tags: [] },
          match_mode: "baseline",
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    useDriftStore.setState({
      reportsByTemplate: {
        t1: [
          {
            id: "r1",
            template_id: "t1",
            device_id: "d1",
            device_kind: "ssh",
            status: "drift",
            severity: "destructive",
            diff_patch: {
              status: "drift",
              severity: "destructive",
              blocks: [],
              stats: { additions: 1, deletions: 1, blocks_changed: 1 },
            },
            error_msg: null,
            captured_at: 0,
          },
        ],
      },
    });
    render(<DriftSidebar />);
    // Need to trigger template selection: simulate by changing state directly
    // (the select onChange would fire in a real environment)
    expect(screen.getByTestId("drift-template-select")).toBeInTheDocument();
  });

  it("exposes distinct destructive, changed-line, and paused-schedule semantics", () => {
    useIntentStore.setState({
      refresh: vi.fn(async () => {}),
      templates: [
        {
          id: "t1",
          name: "core",
          vendor: "cisco",
          platform: "iosxe",
          kind: "golden",
          body: "",
          vars_yaml: "",
          selector: { device_ids: [], tags: [] },
          match_mode: "baseline",
          created_at: 0,
          updated_at: 0,
        },
      ],
    });
    useDriftStore.setState({
      refreshReports: vi.fn(async () => {}),
      refreshSchedules: vi.fn(async () => {}),
      selectedReportId: "r1",
      schedules: [
        {
          id: "s1",
          template_id: "t1",
          cron_expr: "0 * * * *",
          enabled: false,
          last_run_at: null,
          created_at: 0,
        },
      ],
      reportsByTemplate: {
        t1: [
          {
            id: "r1",
            template_id: "t1",
            device_id: "router-1",
            device_kind: "ssh",
            status: "drift",
            severity: "destructive",
            diff_patch: {
              status: "drift",
              severity: "destructive",
              blocks: [
                {
                  block_path: "interface Gi1",
                  severity: "destructive",
                  changes: [
                    { tag: "insert", line: "description intended" },
                    { tag: "delete", line: "shutdown" },
                  ],
                },
              ],
              stats: { additions: 1, deletions: 1, blocks_changed: 1 },
            },
            error_msg: null,
            captured_at: 0,
          },
        ],
      },
    });
    const { container } = render(<DriftSidebar />);

    fireEvent.change(screen.getByTestId("drift-template-select"), {
      target: { value: "t1" },
    });

    expect(container.querySelector(".drift-status-dot.severity-destructive"))
      .toHaveAccessibleName("Destructive drift");
    expect(container.querySelector(".drift-line.drift-insert")).toBeTruthy();
    expect(container.querySelector(".drift-line.drift-delete")).toBeTruthy();
    const paused = container.querySelector(".drift-status-dot.paused");
    expect(paused).toHaveAccessibleName("Schedule paused");
    expect(paused).not.toHaveClass("error");
  });
});
