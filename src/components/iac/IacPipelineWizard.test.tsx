import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IacPipelineWizard } from "./IacPipelineWizard";

const generatePipeline = vi.fn();
vi.mock("../../lib/tauri", () => ({
  iacGeneratePipeline: (...a: unknown[]) => generatePipeline(...a),
}));

function res(code: string) {
  return {
    tool: "pipeline", code, filename: "pipeline.yml", explanation: "",
    estimated_apply_time_seconds: 5,
    validation: { valid: null, skipped: true, error: null }, unavailable: false,
  };
}

describe("IacPipelineWizard", () => {
  beforeEach(() => generatePipeline.mockReset());

  it("both platforms selected => two proposals with correct target paths", async () => {
    generatePipeline.mockResolvedValueOnce(res("on: pull_request")).mockResolvedValueOnce(res("stages:"));
    const onProposals = vi.fn();
    render(<IacPipelineWizard rootPath="/root" detectedTool="terraform" onProposals={onProposals} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("pipe-gl"));      // add GitLab CI (GitHub is pre-checked)
    fireEvent.click(screen.getByTestId("pipe-generate"));

    await waitFor(() => expect(onProposals).toHaveBeenCalled());
    const proposals = onProposals.mock.calls[0][0];
    expect(proposals).toHaveLength(2);
    expect(proposals[0].target_path).toBe("/root/.github/workflows/terraform.yml");
    expect(proposals[1].target_path).toBe("/root/.gitlab-ci.yml");
    // Generated via the dedicated pipeline RPC (platform, tool, flow, auth) —
    // never the terraform/ansible codegen path.
    expect(generatePipeline.mock.calls[0][0]).toBe("github");
    expect(generatePipeline.mock.calls[0][1]).toBe("terraform");
    expect(generatePipeline.mock.calls[1][0]).toBe("gitlab");
  });

  it("folds auth/env text into the pipeline request", async () => {
    generatePipeline.mockResolvedValue(res("on: pull_request"));
    render(<IacPipelineWizard rootPath="/root" detectedTool="terraform" onProposals={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("pipe-auth"), { target: { value: "AWS via OIDC" } });
    fireEvent.click(screen.getByTestId("pipe-generate"));
    await waitFor(() => expect(generatePipeline).toHaveBeenCalled());
    // auth is the 4th positional arg (platform, tool, flow, auth)
    expect(generatePipeline.mock.calls[0][3]).toBe("AWS via OIDC");
  });

  it("requires at least one platform", () => {
    render(<IacPipelineWizard rootPath="/root" detectedTool="terraform" onProposals={vi.fn()} onClose={vi.fn()} />);
    // GitHub is checked by default → enabled
    expect(screen.getByTestId("pipe-generate")).not.toBeDisabled();
    // Uncheck the only selected platform → disabled
    fireEvent.click(screen.getByTestId("pipe-gh"));
    expect(screen.getByTestId("pipe-generate")).toBeDisabled();
  });
});
