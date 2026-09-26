import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IacResourceWizard } from "./IacResourceWizard";

const generateTerraform = vi.fn();
vi.mock("../../lib/tauri", () => ({
  iacGenerateTerraform: (...a: unknown[]) => generateTerraform(...a),
  iacGenerateAnsible: vi.fn(),
}));

function okResult() {
  return {
    tool: "terraform", code: 'resource "aws_instance" "web_server" {}',
    filename: "web_server.tf", explanation: "an instance",
    estimated_apply_time_seconds: 10,
    validation: { valid: null, skipped: true, error: null }, unavailable: false,
  };
}

describe("IacResourceWizard", () => {
  beforeEach(() => generateTerraform.mockReset());

  it("composes an intent from the fields and emits a proposal with target_path", async () => {
    generateTerraform.mockResolvedValue(okResult());
    const onProposal = vi.fn();
    render(
      <IacResourceWizard rootPath="/root" onProposal={onProposal} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId("res-type"), { target: { value: "aws_instance" } });
    fireEvent.change(screen.getByTestId("res-name"), { target: { value: "web_server" } });
    fireEvent.change(screen.getByTestId("res-details"), { target: { value: "t3.micro" } });
    fireEvent.click(screen.getByTestId("res-generate"));

    await waitFor(() => expect(onProposal).toHaveBeenCalled());
    const intent = generateTerraform.mock.calls[0][0] as string;
    expect(intent).toContain("aws_instance");
    expect(intent).toContain("web_server");
    expect(intent).toContain("t3.micro");
    const proposal = onProposal.mock.calls[0][0];
    expect(proposal.target_path).toBe("/root/web_server.tf");
  });

  it("surfaces an honest error and emits no proposal when unavailable", async () => {
    generateTerraform.mockResolvedValue({ ...okResult(), unavailable: true, code: "" });
    const onProposal = vi.fn();
    render(<IacResourceWizard rootPath="/root" onProposal={onProposal} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("res-type"), { target: { value: "aws_instance" } });
    fireEvent.change(screen.getByTestId("res-name"), { target: { value: "web_server" } });
    fireEvent.click(screen.getByTestId("res-generate"));
    await waitFor(() => expect(screen.getByTestId("res-error")).toBeInTheDocument());
    expect(onProposal).not.toHaveBeenCalled();
  });
});
