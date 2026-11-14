import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TelemetryTab } from "./TelemetryTab";
import { telemetryWorkspaces } from "./store";
import { telemetryApi } from "./api";
import { sshListConnections } from "../../lib/sshConnections";
import type { StartRequest, TelemetrySnapshot } from "./types";
vi.mock("../../components/editor/MonacoEditor", () => ({ DEFAULT_EDITOR_SETTINGS: {}, MonacoEditor: ({ value, onChange }: { value: string; onChange(value: string): void }) => <textarea aria-label="Source editor" value={value} onChange={(event) => onChange(event.target.value)} /> }));
vi.mock("../../lib/sshConnections", () => ({
  sshListConnections: vi.fn().mockResolvedValue([
    { id: "one", name: "Saved IOS-XE", platform: "iosxe" },
    { id: "generic", name: "Generic SSH", platform: "generic" },
    { id: "unsupported", name: "Unsupported", platform: "junos" },
  ]),
}));

vi.mock("./api", () => ({
  telemetryApi: {
    establish: vi.fn().mockResolvedValue({
      workspace_id: "tab",
      generation: 1,
      sequence: 0,
      running: false,
      targets: [],
      widgets: [],
      series: [],
      diagnostics: [],
    }),
    start: vi.fn().mockResolvedValue({
      workspace_id: "tab",
      generation: 2,
      sequence: 0,
      running: true,
      targets: [],
      widgets: [],
      series: [],
      diagnostics: [],
    }),
    snapshot: vi.fn().mockResolvedValue({
      workspace_id: "tab",
      generation: 1,
      sequence: 0,
      running: false,
      targets: [],
      widgets: [],
      series: [],
      diagnostics: [],
    }),
    stop: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    catalog: vi.fn().mockResolvedValue({ workspace_id: "tab", generation: 1, sequence: 0, revision: "base", value: { effective: { revision: "source", widgets: [], layouts: [], templates: {} }, own: { scope: "local", widgets_yaml: "schema_version: 1\nwidgets: []\n", layouts_yaml: "schema_version: 1\nlayouts: []\n", templates: {}, expected_revision: "base" }, inherited: { widgets: {}, layouts: {}, templates: {} }, builtin: { widgets: {}, layouts: {}, templates: {} }, origins: { widgets: {}, layouts: {}, templates: {} } } }),
  },
}));
afterEach(async () => {
  await telemetryWorkspaces.close("tab");
  vi.clearAllMocks();
});
it.each([false, true])("awaits running selection reconciliation and preserves prior selection on failure (%s)", async (fail) => {
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  vi.mocked(sshListConnections).mockResolvedValueOnce(["one", "two", "three"].map((id) => ({ id, name: `Saved ${id}`, platform: "iosxe" })) as Awaited<ReturnType<typeof sshListConnections>>);
  const request: StartRequest = { workspace_id: "tab", targets: ["one", "two"].map((connection_id) => ({ connection_id, platform: "iosxe" })), local_enabled: true, monitored_interfaces: { two: ["Gi0/1"] } };
  const result = (r: StartRequest, generation: number): TelemetrySnapshot => ({ workspace_id: "tab", generation, sequence: 0, running: true, targets: [...r.targets.map((t) => ({ target_id: t.connection_id, display_name: `Saved ${t.connection_id}`, platform: t.platform, monitoring_selected: true, state: "fresh" as const, last_success_at_ms: 1, diagnostics: [] })), ...(r.local_enabled ? [{ target_id: "local", display_name: "Local PC", platform: null, monitoring_selected: true, state: "fresh" as const, last_success_at_ms: 1, diagnostics: [] }] : [])], widgets: [], series: [], diagnostics: [] });
  vi.mocked(telemetryApi.start).mockResolvedValueOnce(result(request, 2));
  await telemetryWorkspaces.establish("tab");
  await telemetryWorkspaces.start(request);
  let resolve!: (value: TelemetrySnapshot) => void;
  let reject!: (error: Error) => void;
  vi.mocked(telemetryApi.start).mockImplementationOnce(() => new Promise((yes, no) => { resolve = yes; reject = no; }));
  render(<TelemetryTab tabId="tab" />);
  fireEvent.click(screen.getByRole("button", { name: "Manage targets" }));
  fireEvent.click(await screen.findByLabelText("Saved one"));
  fireEvent.click(screen.getByLabelText("Saved three"));
  fireEvent.click(screen.getByLabelText("Monitor this computer"));
  fireEvent.click(screen.getByRole("button", { name: "Use selection" }));
  await waitFor(() => expect(telemetryApi.start).toHaveBeenCalledTimes(2));
  const applied: StartRequest = { ...request, targets: request.targets.slice(1).concat({ connection_id: "three", platform: "iosxe" }), local_enabled: false };
  expect(telemetryApi.start).toHaveBeenLastCalledWith(applied);
  expect(screen.getByRole("dialog")).toBeVisible();
  if (fail) {
    await act(async () => reject(new Error("Selection refused")));
    expect(screen.getByRole("alert")).toHaveTextContent("Selection refused");
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage targets" }));
    expect(screen.getByLabelText("Saved one")).toBeChecked();
    expect(screen.getByLabelText("Saved three")).not.toBeChecked();
    expect(screen.getByLabelText("Monitor this computer")).toBeChecked();
  } else {
    await act(async () => resolve(result(applied, 3)));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(telemetryWorkspaces.state.getState().workspaces.tab.snapshot?.targets.map((t) => t.target_id)).toEqual(["two", "three"]);
  }
});
it("preserves invalid YAML/layout/template drafts and close guard across workspace navigation", async () => {
  const view = render(<TelemetryTab tabId="tab" />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Start" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Widgets", exact: true }));
  const source = await screen.findByRole("textbox", { name: "Source editor" });
  fireEvent.change(source, { target: { value: "# exact invalid YAML\ninvalid: [" } });
  fireEvent.click(screen.getByRole("button", { name: "Fleet", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "Widgets", exact: true }));
  expect(screen.getByRole("textbox", { name: "Source editor" })).toHaveValue("# exact invalid YAML\ninvalid: [");
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await act(async () => { await expect(telemetryWorkspaces.close("tab")).rejects.toThrow("canceled"); });
  expect(telemetryApi.close).not.toHaveBeenCalled();
  view.unmount(); confirm.mockRestore();
});
it("survives StrictMode subscription cleanup with one stopped workspace and explicit Start", async () => {
  const view = render(
    <StrictMode>
      <TelemetryTab tabId="tab" />
    </StrictMode>,
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(telemetryApi.establish).toHaveBeenCalledOnce();
  expect(telemetryApi.start).not.toHaveBeenCalled();
  expect(telemetryApi.close).not.toHaveBeenCalled();
  expect(screen.getByText("Stopped")).toBeInTheDocument();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Start" })),
  );
  expect(telemetryApi.start).toHaveBeenCalledOnce();
  view.rerender(
    <StrictMode>
      <div hidden>
        <TelemetryTab tabId="tab" />
      </div>
    </StrictMode>,
  );
  expect(telemetryApi.close).not.toHaveBeenCalled();
  view.unmount();
  expect(telemetryApi.close).not.toHaveBeenCalled();
});
it("renders a bootstrap failure without claiming monitoring or collecting", async () => {
  vi.mocked(telemetryApi.establish).mockRejectedValueOnce({
    code: "service_busy",
    message: "Telemetry transport unavailable",
  });
  render(<TelemetryTab tabId="tab" />);
  expect(screen.getByRole("button", { name: "Start" })).toBeDisabled();
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Telemetry transport unavailable",
  );
  expect(screen.getByRole("status")).toHaveTextContent(
    "Telemetry status unavailable",
  );
  expect(telemetryApi.start).not.toHaveBeenCalled();
});
it("requires explicit Start after target selection and preserves the chosen saved identity", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  render(<TelemetryTab tabId="tab" />);
  await screen.findByRole("button", { name: "Manage targets" });
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Manage targets" })),
  );
  fireEvent.click(await screen.findByLabelText("Saved IOS-XE"));
  fireEvent.click(screen.getByRole("button", { name: "Use selection" }));
  expect(telemetryApi.start).not.toHaveBeenCalled();
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Start", exact: true })),
  );
  expect(telemetryApi.start).toHaveBeenCalledWith(
    expect.objectContaining({
      targets: [{ connection_id: "one", platform: "iosxe" }],
    }),
  );
});
it("requires an explicit IOS profile before admitting a generic saved connection", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  render(<TelemetryTab tabId="tab" />);
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.click(screen.getByRole("button", { name: "Manage targets" }));
  expect(
    await screen.findByLabelText("Generic SSH", { selector: "input" }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Platform for Generic SSH"), {
    target: { value: "ios" },
  });
  expect(
    screen.getByLabelText("Generic SSH", { selector: "input" }),
  ).toBeEnabled();
});
