import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetStudio } from "./WidgetStudio";
import { TelemetryApi, telemetryApi } from "./api";
import { telemetryWorkspaces } from "./store";
import type {
  AuthoringCatalog,
  TelemetryRead,
  TelemetrySnapshot,
  WidgetPage,
  WidgetSummary,
} from "./types";
vi.mock("../../components/editor/MonacoEditor", () => ({
  DEFAULT_EDITOR_SETTINGS: {},
  MonacoEditor: ({
    value,
    onChange,
    readOnly,
  }: {
    value: string;
    onChange(value: string): void;
    readOnly: boolean;
  }) => (
    <textarea
      aria-label="Source editor"
      value={value}
      readOnly={readOnly}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
const catalog = (): AuthoringCatalog => ({
  effective: {
    revision: "source",
    widgets: [
      {
        widget: "cpu",
        title: "CPU",
        source: { kind: "local", collector: "local.cpu" },
        interval: 2,
        key: ["id"],
        fields: { id: ["id"] },
        view: { type: "table", columns: [{ field: "id", label: "Identity" }] },
      },
    ],
    layouts: [],
    templates: {},
  },
  own: {
    scope: "local",
    widgets_yaml: "schema_version: 1\nwidgets: []\n",
    layouts_yaml: "schema_version: 1\nlayouts: []\n",
    templates: {},
    expected_revision: "base",
  },
  inherited: { widgets: {}, layouts: {}, templates: {} },
  builtin: { widgets: {}, layouts: {}, templates: {} },
  origins: { widgets: { cpu: "builtin" }, layouts: {}, templates: {} },
});
const reply = <T,>(value: T): TelemetryRead<T> => ({
  workspace_id: "ui",
  generation: 1,
  sequence: 1,
  revision: "base",
  value,
});
function fixture() {
  const api = new TelemetryApi();
  vi.spyOn(api, "validate").mockResolvedValue(
    reply({
      valid: true,
      draft_hash: "native",
      affected_targets: ["switch-a"],
      masked_device_overrides: ["switch-b"],
      diagnostics: [],
    }),
  );
  vi.spyOn(api, "preview").mockResolvedValue(
    reply({
      token: {
        id: "native-token",
        draft_hash: "native",
        base_revision: "base",
        expires_at_ms: Date.now() + 10000,
        sample_hashes: {},
      },
      frames: [],
      diagnostics: [],
      captures: [],
      interpretations: [],
      frame_sources: [],
      local_samples: [],
    }),
  );
  vi.spyOn(api, "captureSample");
  vi.spyOn(api, "apply").mockRejectedValue(new Error("disk write failed"));
  return api;
}
beforeEach(() => {
  telemetryWorkspaces.state.setState({
    workspaces: {
      ui: {
        snapshot: {
          workspace_id: "ui",
          generation: 1,
          sequence: 1,
          running: false,
          targets: [],
          widgets: [],
          series: [],
          diagnostics: [],
        },
        busy: false,
        closing: false,
        error: null,
      },
    },
  });
  vi.spyOn(telemetryWorkspaces, "read").mockImplementation(
    (_id, _key, action) => action(),
  );
  vi.spyOn(telemetryWorkspaces, "registerDraft").mockReturnValue(() => {});
});
describe("Widget Studio", () => {
  it.each([
    "stopped",
    "stale",
    "failed",
    "removed",
    "time",
    "revision",
    "generation",
    "rows",
    "source",
  ] as const)(
    "reconciles retained applied data with current native %s authority after failed refresh",
    async (change) => {
      vi.mocked(telemetryWorkspaces.read).mockRestore();
      vi.mocked(telemetryWorkspaces.registerDraft).mockRestore();
      const metadata: WidgetSummary = {
        workspace_id: "applied",
        target_id: "local",
        widget_id: "cpu",
        revision: "source",
        generation: 1,
        observed_at_ms: 1000,
        last_success_at_ms: 1000,
        state: "fresh",
        severity: "info",
        units: {},
        row_count: 1,
        diagnostics: [],
      };
      const page: WidgetPage = {
        metadata,
        rows: [
          {
            key: "retained",
            fields: { id: { kind: "text", value: "retained value" } },
          },
        ],
        next_offset: null,
      };
      let current: TelemetrySnapshot = {
        workspace_id: "applied",
        generation: 1,
        sequence: 1,
        running: true,
        targets: [],
        widgets: [metadata],
        series: [],
        diagnostics: [],
      };
      const wrap = <T,>(value: T, revision: string): TelemetryRead<T> => ({
        workspace_id: "applied",
        generation: current.generation,
        sequence: current.sequence,
        revision,
        value,
      });
      vi.spyOn(telemetryApi, "establish").mockImplementation(
        async () => current,
      );
      vi.spyOn(telemetryApi, "snapshot").mockImplementation(
        async () => current,
      );
      let currentCatalog = catalog();
      vi.spyOn(telemetryApi, "catalog").mockImplementation(async () =>
        wrap(currentCatalog, "base"),
      );
      const widget = vi
        .spyOn(telemetryApi, "widget")
        .mockImplementation(async () => wrap(page, "source"));
      vi.spyOn(telemetryApi, "close").mockResolvedValue(undefined);
      await telemetryWorkspaces.establish("applied");
      const view = render(
        <WidgetStudio
          workspaceId="applied"
          api={telemetryApi}
          catalog={catalog()}
        />,
      );
      try {
        const applied = screen.getByRole("region", {
          name: "Last applied widget",
        });
        expect(
          await within(applied).findByText("retained value"),
        ).toBeVisible();
        fireEvent.change(
          screen.getByRole("textbox", { name: "Source editor" }),
          { target: { value: "# exact invalid draft\ninvalid: [" } },
        );
        expect(within(applied).getByText("retained value")).toBeVisible();
        widget.mockRejectedValue(new Error("Fixture refresh failed"));
        const summary = { ...metadata };
        if (change === "source") {
          currentCatalog = {
            ...currentCatalog,
            effective: {
              ...currentCatalog.effective,
              revision: "new-source",
              widgets: [
                {
                  ...currentCatalog.effective.widgets[0],
                  title: "Changed current definition",
                },
              ],
            },
          };
          summary.state = "stale";
          summary.severity = "alert";
          summary.diagnostics = [
            {
              code: "current_quality",
              message: "Current native quality",
              path: "cpu",
              line: null,
              column: null,
            },
          ];
        }
        if (change === "stopped" || change === "stale" || change === "failed") {
          summary.state = change;
          summary.severity = "alert";
          summary.diagnostics = [
            {
              code: "current_quality",
              message: "Current native quality",
              path: "cpu",
              line: null,
              column: null,
            },
          ];
        }
        if (change === "time") summary.observed_at_ms++;
        if (change === "revision")
          summary.revision = "another-observation-source";
        if (change === "generation") summary.generation++;
        if (change === "rows") summary.row_count++;
        await act(async () => {
          current = {
            ...current,
            generation: 2,
            sequence: 2,
            running: change !== "stopped",
            widgets: change === "removed" ? [] : [summary],
          };
          telemetryWorkspaces.state.setState((state) => ({
            workspaces: {
              ...state.workspaces,
              applied: { ...state.workspaces.applied, snapshot: current },
            },
          }));
        });
        if (["stopped", "stale", "failed", "source"].includes(change)) {
          expect(
            await within(applied).findByText("Fixture refresh failed"),
          ).toBeVisible();
          expect(widget.mock.calls.length).toBeGreaterThan(1);
          expect(
            within(applied).getByText(
              change === "stopped"
                ? /Stopped/
                : change === "failed"
                  ? /Collection failed/
                  : /Stale/,
            ),
          ).toBeVisible();
          expect(
            within(applied).getByText("Current native quality"),
          ).toBeVisible();
          expect(within(applied).getByText("retained value")).toBeVisible();
          expect(applied.querySelector(".telemetry-panel")).toHaveAttribute(
            "data-severity",
            "alert",
          );
          expect(within(applied).queryByText(/Fresh/)).not.toBeInTheDocument();
        } else {
          expect(
            within(applied).queryByText("retained value"),
          ).not.toBeInTheDocument();
          expect(within(applied).queryByText(/Fresh/)).not.toBeInTheDocument();
        }
        if (change === "source") {
          expect(
            within(applied).getByText(
              "Retained observation uses the previous applied definition.",
            ),
          ).toBeVisible();
          expect(
            within(applied).getByRole("heading", { name: "CPU", exact: true }),
          ).toBeVisible();
          expect(
            within(applied).queryByText("Changed current definition"),
          ).not.toBeInTheDocument();
        }
        await act(async () => {
          current = {
            ...current,
            generation: 3,
            sequence: 3,
            running: false,
            widgets: [{ ...metadata, state: "stopped" }],
          };
          telemetryWorkspaces.state.setState((state) => ({
            workspaces: {
              ...state.workspaces,
              applied: { ...state.workspaces.applied, snapshot: current },
            },
          }));
        });
        expect(within(applied).getByText("retained value")).toBeVisible();
        expect(within(applied).getByText(/Stopped/)).toBeVisible();
        expect(
          screen.getByRole("textbox", { name: "Source editor" }),
        ).toHaveValue("# exact invalid draft\ninvalid: [");
      } finally {
        view.unmount();
        await telemetryWorkspaces.close("applied");
        vi.restoreAllMocks();
      }
    },
  );
  it.each([
    "schema_version: 1\nwidgets:\n  -\n",
    "schema_version: 1\nwidgets:\n  - widget: cpu\n    title: [unfinished]\n    source: {kind: ssh}\n",
    "schema_version: 1\nwidgets:\n  - widget: partial\n    title: Partial\n    source: {kind: ssh, templates: null, commands: null}\n",
  ])(
    "preserves incomplete YAML while the library remains usable (%s)",
    (text) => {
      render(
        <WidgetStudio workspaceId="ui" api={fixture()} catalog={catalog()} />,
      );
      fireEvent.change(screen.getByRole("textbox", { name: "Source editor" }), {
        target: { value: text },
      });
      expect(
        screen.getByRole("textbox", { name: "Source editor" }),
      ).toHaveValue(text);
      expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
      expect(
        screen.getByRole("heading", { name: "Last applied widget" }),
      ).toBeVisible();
    },
  );
  it("studio_draft_change_invalidates_preview_and_apply", async () => {
    const api = fixture();
    render(<WidgetStudio workspaceId="ui" api={api} catalog={catalog()} />);
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled(),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Source editor" }), {
      target: { value: "invalid: draft" },
    });
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.queryByText(/^Preview ready\./)).not.toBeInTheDocument();
    expect(api.captureSample).not.toHaveBeenCalled();
  });
  it("stale_validate_and_preview_replies_are_ignored", async () => {
    const api = fixture();
    let resolve!: (v: Awaited<ReturnType<TelemetryApi["preview"]>>) => void;
    const result = await api.preview("unused", catalog().own);
    vi.mocked(api.preview).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    render(<WidgetStudio workspaceId="ui" api={api} catalog={catalog()} />);
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Preview" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Source editor" }), {
      target: { value: "new draft" },
    });
    await act(async () => resolve(result));
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(api.captureSample).not.toHaveBeenCalled();
  });
  it("apply_shows_affected_and_masked_overrides", async () => {
    render(
      <WidgetStudio workspaceId="ui" api={fixture()} catalog={catalog()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Validate" }));
    expect(await screen.findByText(/switch-a/)).toBeVisible();
    expect(screen.getByText(/switch-b/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
  });
});
