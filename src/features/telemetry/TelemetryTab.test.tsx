import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TelemetryTab } from "./TelemetryTab";
import { telemetryWorkspaces } from "./store";
import { telemetryApi } from "./api";

vi.mock("./api", () => ({
  telemetryApi: {
    establish: vi
      .fn()
      .mockResolvedValue({
        workspace_id: "tab",
        generation: 1,
        sequence: 0,
        running: false,
        targets: [],
        widgets: [],
        series: [],
        diagnostics: [],
      }),
    start: vi
      .fn()
      .mockResolvedValue({
        workspace_id: "tab",
        generation: 2,
        sequence: 0,
        running: true,
        targets: [],
        widgets: [],
        series: [],
        diagnostics: [],
      }),
    snapshot: vi
      .fn()
      .mockResolvedValue({
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
