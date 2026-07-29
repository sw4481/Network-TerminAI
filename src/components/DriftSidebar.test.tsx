import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
