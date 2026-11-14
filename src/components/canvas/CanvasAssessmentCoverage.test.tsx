import { act, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { CanvasWorkspace } from "./CanvasWorkspace";
import { useCopilotCanvas } from "../../state/copilotCanvasStore";
import { useTabs } from "../../state/tabsStore";
import { useChatStore } from "../../state/chatStore";
import type { CanvasWorkspaceSnapshot } from "../../lib/tauri";
import { canvasOpenWorkspace, canvasSaveEvent, canvasSaveRun } from "../../lib/tauri";

vi.mock("../../lib/tauri", () => ({
  canvasOpenWorkspace: vi.fn(), canvasListWorkspaces: vi.fn().mockResolvedValue([]),
  canvasRenameWorkspace: vi.fn(), canvasSaveRun: vi.fn().mockResolvedValue(undefined),
  canvasSaveEvent: vi.fn().mockResolvedValue(undefined),
}));

let number = 0;
let saved: CanvasWorkspaceSnapshot;
beforeEach(() => {
  vi.clearAllMocks();
  const tab = { id: `coverage-${++number}`, title: "Synthetic investigation", shell_cmd: "", cwd: "", created_at: 0, tab_type: "canvas" as const };
  saved = { tab, runs: [], evidence: [], cards: [], warnings: [] };
  useCopilotCanvas.setState({ workspaces: {} });
  useTabs.setState({ tabs: [tab], activeTabId: tab.id });
  useChatStore.setState({ messages: {}, streaming: {} });
  vi.mocked(canvasOpenWorkspace).mockImplementation(async () => structuredClone(saved));
  vi.mocked(canvasSaveRun).mockImplementation(async (_, run) => {
    saved.runs = [...saved.runs.filter(item => item.run_id !== run.run_id), structuredClone(run)];
  });
  vi.mocked(canvasSaveEvent).mockImplementation(async (_, event) => {
    if (event.kind === "coverage") saved.runs.find(run => run.run_id === event.run_id)!.coverage = structuredClone(event.payload);
  });
});

it("keeps partial collection prominent after completion and a data-only reopen", async () => {
  const id = saved.tab.id;
  await useCopilotCanvas.getState().load(id);
  await useCopilotCanvas.getState().beginRun(id, "blocked-run");
  const event = { type: "canvas" as const, version: 1 as const, workspace_id: id, run_id: "blocked-run", seq: 1, kind: "coverage" as const,
    payload: { collection_status: "partial", failed_helpers: ["synthetic_api_call"], limitation: "One source was unavailable. Retained results do not cover the requested scope." } };
  let view!: ReturnType<typeof render>;
  await act(async () => { view = render(<CanvasWorkspace workspaceId={id} />); });
  const status = screen.getByRole("region", { name: "Investigation status" });
  const announcement = within(status).getByRole("status");
  expect(announcement).toBeEmptyDOMElement();
  await act(async () => useCopilotCanvas.getState().accept(event));
  expect(announcement).toHaveTextContent("Assessment incomplete — collection blocked");
  await act(async () => useCopilotCanvas.getState().finishRun(id, "blocked-run", "completed"));
  expect(canvasSaveEvent).toHaveBeenCalledWith(id, event);
  expect(status).toHaveTextContent("Run status: completed.");
  expect(status).toHaveTextContent("Assessment incomplete — collection blocked");
  expect(status).toHaveTextContent("One source was unavailable.");
  expect(status).toHaveTextContent("synthetic_api_call");

  expect(saved.runs[0].coverage).toEqual(event.payload);
  view.unmount();
  useCopilotCanvas.setState({ workspaces: {} });
  await act(async () => { render(<CanvasWorkspace workspaceId={id} />); });
  expect(await screen.findByText("Assessment incomplete — collection blocked")).toBeVisible();
  expect(screen.getByRole("region", { name: "Assessment coverage" })).toHaveTextContent("Coverage unknown");
});

it("does not carry an older run's blocker into the latest run or equate completion with coverage", async () => {
  const id = saved.tab.id;
  saved.runs = [
    { workspace_id: id, run_id: "old", status: "completed", started_at: "2026-10-29T10:00:00Z", ended_at: "2026-10-29T10:01:00Z", scope: null,
      coverage: { collection_status: "partial", failed_helpers: ["old_api_call"], limitation: "Old collection failed" } },
    { workspace_id: id, run_id: "latest", status: "completed", started_at: "2026-10-29T11:00:00Z", ended_at: "2026-10-29T11:01:00Z", scope: null, coverage: null },
  ];
  await useCopilotCanvas.getState().load(id);
  await act(async () => { render(<CanvasWorkspace workspaceId={id} />); });
  const status = screen.getByRole("region", { name: "Investigation status" });
  expect(status).toHaveTextContent("Run status: completed.");
  expect(status).toHaveTextContent("Assessment coverage unknown");
  expect(within(status).queryByText(/collection blocked/)).toBeNull();
  expect(status).not.toHaveTextContent("old_api_call");
  await act(async () => useCopilotCanvas.getState().beginRun(id, "next"));
  expect(status).toHaveTextContent("still collecting evidence");
});
