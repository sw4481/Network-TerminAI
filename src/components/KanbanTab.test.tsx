/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { KanbanTab } from "./KanbanTab";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => vi.fn()) }));

describe("KanbanTab", () => {
  beforeEach(() => vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "kanban_list") return [] as never;
    return undefined as never;
  }));

  it("shows compact status lanes and opens task creation on demand", async () => {
    render(<KanbanTab />);
    await act(async () => { await Promise.resolve(); });
    for (const status of ["ready", "running", "blocked", "review", "done", "cancelled"]) {
      expect(screen.getByRole("region", { name: `${status[0].toUpperCase()}${status.slice(1)} tasks` })).toBeInTheDocument();
    }
    expect(screen.getByRole("button", { name: "Ready 0" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "＋ New task" }));
    expect(screen.getByRole("dialog", { name: "New task" })).toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "Task title" }), { target: { value: "Inspect the route" } });
    fireEvent.change(screen.getByRole("textbox", { name: "What should the agent do?" }), { target: { value: "Check connectivity" } });
    fireEvent.click(screen.getByRole("button", { name: "Add task" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("kanban_create", {
      input: { title: "Inspect the route", details: "Check connectivity", completionMode: "autonomous", paneContext: null },
    }));
  });
});
