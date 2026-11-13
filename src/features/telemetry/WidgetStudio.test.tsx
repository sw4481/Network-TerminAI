import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WidgetStudio } from "./WidgetStudio";
import { TelemetryApi } from "./api";
import { telemetryWorkspaces } from "./store";
import type { AuthoringCatalog, TelemetryRead } from "./types";
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
