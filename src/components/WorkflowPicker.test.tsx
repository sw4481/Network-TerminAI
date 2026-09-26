import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkflowPicker } from "./WorkflowPicker";
import { useWorkflowsStore } from "../state/workflowsStore";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => []) }));

beforeEach(() => {
  useWorkflowsStore.setState({
    workflows: [
      {
        id: "1",
        name: "Show interface counters",
        description: "Per-interface TX/RX counters",
        vendor: "cisco",
        platform: "iosxe",
        tags: ["interfaces", "counters"],
        steps: [
          { idx: 0, command_template: "show interface {{ intf }} counters" },
        ],
        params: [
          {
            name: "intf",
            type: "interface",
            default_value: null,
            required: true,
            description: "",
            enum_values: null,
          },
        ],
        created_at: 0,
        updated_at: 0,
      },
      {
        id: "2",
        name: "Show BGP summary",
        description: "All BGP neighbors and state",
        vendor: "cisco",
        platform: "iosxe",
        tags: ["bgp"],
        steps: [{ idx: 0, command_template: "show bgp summary" }],
        params: [],
        created_at: 0,
        updated_at: 0,
      },
    ],
    loading: false,
    error: null,
  });
});

describe("WorkflowPicker", () => {
  it("filters by query", () => {
    render(
      <WorkflowPicker
        vendor="cisco"
        platform="iosxe"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const search = screen.getByPlaceholderText(/search workflows/i);
    fireEvent.change(search, { target: { value: "bgp" } });
    expect(screen.getByText("Show BGP summary")).toBeInTheDocument();
    expect(
      screen.queryByText("Show interface counters"),
    ).not.toBeInTheDocument();
  });

  it("Enter selects highlighted workflow with editParamsFirst=false", () => {
    const onSelect = vi.fn();
    render(
      <WorkflowPicker
        vendor="cisco"
        platform="iosxe"
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: "Enter" });
    // First workflow in the store fixture is "Show interface counters" (index 0).
    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Show interface counters" }),
      false,
    );
  });

  it("Cmd+Enter selects with editParamsFirst=true", () => {
    const onSelect = vi.fn();
    render(
      <WorkflowPicker
        vendor="cisco"
        platform="iosxe"
        onSelect={onSelect}
        onClose={vi.fn()}
      />,
    );
    fireEvent.keyDown(window, { key: "Enter", metaKey: true });
    expect(onSelect).toHaveBeenCalledWith(expect.any(Object), true);
  });

  it("Escape calls onClose", () => {
    const onClose = vi.fn();
    render(
      <WorkflowPicker
        vendor="cisco"
        platform="iosxe"
        onSelect={vi.fn()}
        onClose={onClose}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("Down/Up arrow keys move highlight (visible via aria-selected)", () => {
    render(
      <WorkflowPicker
        vendor="cisco"
        platform="iosxe"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(window, { key: "ArrowDown" });
    const options2 = screen.getAllByRole("option");
    expect(options2[1].getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(window, { key: "ArrowUp" });
    const options3 = screen.getAllByRole("option");
    expect(options3[0].getAttribute("aria-selected")).toBe("true");
  });

  it("renders step-count badge and tag chips", () => {
    render(
      <WorkflowPicker
        vendor="cisco"
        platform="iosxe"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // Plural for the BGP one (1 step) — actually both are 1 step in fixture.
    expect(screen.getAllByText(/1 step$/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("interfaces")).toBeInTheDocument();
    expect(screen.getByText("counters")).toBeInTheDocument();
    expect(screen.getByText("bgp")).toBeInTheDocument();
  });

  it("shows 'No workflows' when query has no matches", () => {
    render(
      <WorkflowPicker
        vendor="cisco"
        platform="iosxe"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByPlaceholderText(/search workflows/i), {
      target: { value: "zzzzznothing" },
    });
    expect(screen.getByText(/No workflows match/i)).toBeInTheDocument();
  });

  it("toggling 'all vendors' updates the scope chip", () => {
    render(
      <WorkflowPicker
        vendor="cisco"
        platform="iosxe"
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByText("cisco/iosxe")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /all/i }));
    expect(screen.getByText("all vendors")).toBeInTheDocument();
  });
});
