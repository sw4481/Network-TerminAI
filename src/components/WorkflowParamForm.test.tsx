import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkflowParamForm } from "./WorkflowParamForm";
import { Workflow } from "../lib/workflows";

const wf: Workflow = {
  id: "1",
  name: "X",
  description: "desc",
  vendor: "cisco",
  platform: "iosxe",
  tags: [],
  steps: [{ idx: 0, command_template: "show interface {{ intf }}" }],
  params: [
    {
      name: "intf",
      type: "interface",
      default_value: null,
      required: true,
      description: "Interface",
      enum_values: null,
    },
    {
      name: "area",
      type: "int",
      default_value: "0",
      required: false,
      description: "OSPF area",
      enum_values: null,
    },
  ],
  created_at: 0,
  updated_at: 0,
};

describe("WorkflowParamForm", () => {
  it("renders one input per param and submits values", () => {
    const onSubmit = vi.fn();
    render(
      <WorkflowParamForm workflow={wf} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText(/intf/i), {
      target: { value: "Gi0/0" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run workflow/i }));
    expect(onSubmit).toHaveBeenCalledWith({ intf: "Gi0/0", area: "0" });
  });

  it("blocks submit when required field missing", () => {
    const onSubmit = vi.fn();
    render(
      <WorkflowParamForm workflow={wf} onSubmit={onSubmit} onCancel={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /run workflow/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/required/i)).toBeInTheDocument();
  });

  it("validates IP type", () => {
    const ipWf: Workflow = {
      ...wf,
      params: [
        {
          name: "neighbor",
          type: "ip",
          default_value: null,
          required: true,
          description: "Peer IP",
          enum_values: null,
        },
      ],
    };
    const onSubmit = vi.fn();
    render(
      <WorkflowParamForm
        workflow={ipWf}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText(/neighbor/i), {
      target: { value: "not-an-ip" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run workflow/i }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText(/IPv4/i)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/neighbor/i), {
      target: { value: "10.0.0.1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /run workflow/i }));
    expect(onSubmit).toHaveBeenCalledWith({ neighbor: "10.0.0.1" });
  });

  it("renders enum as <select> populated from enum_values", () => {
    const enumWf: Workflow = {
      ...wf,
      params: [
        {
          name: "level",
          type: "enum",
          default_value: "1",
          required: true,
          description: "OSPF area type",
          enum_values: ["0", "1", "2"],
        },
      ],
    };
    render(
      <WorkflowParamForm
        workflow={enumWf}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const select = screen.getByLabelText(/level/i) as HTMLSelectElement;
    expect(select.tagName).toBe("SELECT");
    expect(select.value).toBe("1");
  });

  it("Cancel button invokes onCancel", () => {
    const onCancel = vi.fn();
    render(
      <WorkflowParamForm
        workflow={wf}
        onSubmit={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });

  it("calls onValuesChange whenever a value updates", () => {
    const onValuesChange = vi.fn();
    render(
      <WorkflowParamForm
        workflow={wf}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        onValuesChange={onValuesChange}
      />,
    );
    onValuesChange.mockClear();
    fireEvent.change(screen.getByLabelText(/intf/i), {
      target: { value: "Te0/0" },
    });
    expect(onValuesChange).toHaveBeenCalled();
    const calls = onValuesChange.mock.calls;
    const last = calls[calls.length - 1]?.[0];
    expect(last).toEqual({ intf: "Te0/0", area: "0" });
  });
});
