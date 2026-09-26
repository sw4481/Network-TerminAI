import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const iacGenerateTerraform = vi.fn();
const iacGenerateAnsible = vi.fn();
vi.mock("../../lib/tauri", () => ({
  iacGenerateTerraform: (...a: unknown[]) => iacGenerateTerraform(...a),
  iacGenerateAnsible: (...a: unknown[]) => iacGenerateAnsible(...a),
}));

const dispatchAskAi = vi.fn();
vi.mock("../editor/askAi", () => ({
  dispatchAskAi: (...a: unknown[]) => dispatchAskAi(...a),
}));

import { IacAiPanel } from "./IacAiPanel";

const baseProps = {
  tabId: "t1",
  rootPath: "/infra",
  filePath: "/infra/main.tf",
  language: "hcl",
  content: "# current",
  generating: false,
  error: null as string | null,
  onProposal: vi.fn(),
  onGenerating: vi.fn(),
  onError: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("IacAiPanel", () => {
  it("calls iacGenerateTerraform for a .tf file and forwards the proposal", async () => {
    iacGenerateTerraform.mockResolvedValue({
      tool: "terraform",
      code: 'resource "x" "y" {}',
      filename: "x.tf",
      explanation: "e",
      estimated_apply_time_seconds: 1,
      validation: { valid: true, skipped: false, error: null },
      unavailable: false,
    });
    const onProposal = vi.fn();
    render(<IacAiPanel {...baseProps} onProposal={onProposal} />);
    fireEvent.change(screen.getByTestId("iac-ai-prompt"), { target: { value: "make x" } });
    fireEvent.click(screen.getByTestId("iac-ai-generate"));
    await waitFor(() => expect(onProposal).toHaveBeenCalledOnce());
    expect(iacGenerateTerraform).toHaveBeenCalledWith("make x", "/infra", undefined, "# current");
    expect(onProposal).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'resource "x" "y" {}', filename: "x.tf" }),
    );
  });

  it("calls iacGenerateAnsible for a .yml file", async () => {
    iacGenerateAnsible.mockResolvedValue({
      tool: "ansible",
      code: "- hosts: all",
      filename: "p.yml",
      explanation: "e",
      estimated_apply_time_seconds: 0,
      validation: { valid: null, skipped: true, error: null },
      unavailable: false,
    });
    render(<IacAiPanel {...baseProps} filePath="/infra/play.yml" language="yaml" />);
    fireEvent.change(screen.getByTestId("iac-ai-prompt"), { target: { value: "noop" } });
    fireEvent.click(screen.getByTestId("iac-ai-generate"));
    await waitFor(() => expect(iacGenerateAnsible).toHaveBeenCalledOnce());
  });

  it("reports unavailable results as an error, not a proposal", async () => {
    iacGenerateTerraform.mockResolvedValue({
      tool: "terraform",
      code: "",
      filename: "",
      explanation: "",
      estimated_apply_time_seconds: 0,
      validation: { valid: null, skipped: true, error: null },
      unavailable: true,
    });
    const onProposal = vi.fn();
    const onError = vi.fn();
    render(<IacAiPanel {...baseProps} onProposal={onProposal} onError={onError} />);
    fireEvent.change(screen.getByTestId("iac-ai-prompt"), { target: { value: "make x" } });
    fireEvent.click(screen.getByTestId("iac-ai-generate"));
    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onProposal).not.toHaveBeenCalled();
  });

  it("surfaces a rejected RPC promise as an error", async () => {
    iacGenerateTerraform.mockRejectedValue(new Error("sidecar down"));
    const onError = vi.fn();
    render(<IacAiPanel {...baseProps} onError={onError} />);
    fireEvent.change(screen.getByTestId("iac-ai-prompt"), { target: { value: "make x" } });
    fireEvent.click(screen.getByTestId("iac-ai-generate"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith(expect.stringContaining("sidecar down")));
  });

  it("Explain dispatches an Ask-AI event and does not call codegen", () => {
    render(<IacAiPanel {...baseProps} />);
    fireEvent.click(screen.getByTestId("iac-ai-explain"));
    expect(dispatchAskAi).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: "t1", action: "explain", filePath: "/infra/main.tf" }),
    );
    expect(iacGenerateTerraform).not.toHaveBeenCalled();
  });

  it("disables Generate when there is no open file", () => {
    render(<IacAiPanel {...baseProps} filePath={null} />);
    expect(screen.getByTestId("iac-ai-generate")).toBeDisabled();
  });

  it("disables Generate while generating", () => {
    render(<IacAiPanel {...baseProps} generating />);
    expect(screen.getByTestId("iac-ai-generate")).toBeDisabled();
  });

  it("shows the error message when error prop is set", () => {
    render(<IacAiPanel {...baseProps} error="boom" />);
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });
  it("does NOT label a .gitlab-ci.yml as ansible (CI pipeline file)", () => {
    render(<IacAiPanel {...baseProps} filePath="/infra/.gitlab-ci.yml" language="yaml" />);
    // CI pipeline files have their own wizard; the free-form panel must not
    // claim "ansible" or enable Generate for them.
    expect(screen.queryByPlaceholderText(/ansible/i)).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText(/New Pipeline/i)).toBeInTheDocument();
    expect(screen.getByTestId("iac-ai-generate")).toBeDisabled();
  });

  it("treats a .github/workflows/*.yml as a CI pipeline, not ansible", () => {
    render(<IacAiPanel {...baseProps} filePath="/infra/.github/workflows/terraform.yml" language="yaml" />);
    expect(screen.queryByPlaceholderText(/ansible/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("iac-ai-generate")).toBeDisabled();
  });
});
