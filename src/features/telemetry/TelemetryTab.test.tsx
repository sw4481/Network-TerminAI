import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TelemetryTab } from "./TelemetryTab";
import { telemetryWorkspaces } from "./store";
import { telemetryApi } from "./api";
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
  },
}));
afterEach(async () => {
  await telemetryWorkspaces.close("tab");
  vi.clearAllMocks();
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
