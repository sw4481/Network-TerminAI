import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IaCApprovalModal } from "./IaCApprovalModal";
import type { IaCApprovalRequest } from "./IaCApprovalModal";

const baseRequest: IaCApprovalRequest = {
  command: "terraform apply",
  workingDir: "/infra/dev",
  gitBranch: "feature/x",
  blastRadius: "high",
  plannedChanges: {
    toCreate: [{ resourceType: "aws_s3_bucket", resourceName: "a" }],
    toUpdate: [],
    toDestroy: [],
  },
};

describe("IaCApprovalModal", () => {
  it("renders the command, working dir, and blast-radius badge", () => {
    render(
      <IaCApprovalModal request={baseRequest} onApprove={vi.fn()} onCancel={vi.fn()} />
    );
    expect(screen.getByText(/terraform apply/)).toBeTruthy();
    expect(screen.getByText("/infra/dev")).toBeTruthy();
    // blast radius badge shows the tier
    expect(screen.getByText(/high/i)).toBeTruthy();
  });

  it("warns when running on the main branch", () => {
    render(
      <IaCApprovalModal
        request={{ ...baseRequest, gitBranch: "main" }}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/main/)).toBeTruthy();
    expect(screen.getByTestId("iac-branch-warning")).toBeTruthy();
  });

  it("lists planned changes grouped by action", () => {
    render(
      <IaCApprovalModal
        request={{
          ...baseRequest,
          plannedChanges: {
            toCreate: [{ resourceType: "aws_s3_bucket", resourceName: "a" }],
            toUpdate: [{ resourceType: "aws_iam_role", resourceName: "r" }],
            toDestroy: [{ resourceType: "aws_instance", resourceName: "old" }],
          },
        }}
        onApprove={vi.fn()}
        onCancel={vi.fn()}
      />
    );
    expect(screen.getByText(/aws_s3_bucket\.a/)).toBeTruthy();
    expect(screen.getByText(/aws_iam_role\.r/)).toBeTruthy();
    expect(screen.getByText(/aws_instance\.old/)).toBeTruthy();
  });

  it("calls onApprove for a non-critical change (no typed confirm)", () => {
    const onApprove = vi.fn();
    render(
      <IaCApprovalModal request={baseRequest} onApprove={onApprove} onCancel={vi.fn()} />
    );
    fireEvent.click(screen.getByRole("button", { name: /proceed/i }));
    expect(onApprove).toHaveBeenCalledOnce();
  });

  it("calls onCancel when cancel is clicked", () => {
    const onCancel = vi.fn();
    render(
      <IaCApprovalModal request={baseRequest} onApprove={vi.fn()} onCancel={onCancel} />
    );
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("requires typed confirmation for critical/destructive operations", () => {
    const onApprove = vi.fn();
    render(
      <IaCApprovalModal
        request={{ ...baseRequest, blastRadius: "critical" }}
        onApprove={onApprove}
        onCancel={vi.fn()}
      />
    );
    const proceed = screen.getByRole("button", { name: /proceed/i }) as HTMLButtonElement;
    // Disabled until the user types the confirmation phrase.
    expect(proceed.disabled).toBe(true);

    fireEvent.change(screen.getByTestId("iac-typed-confirm"), {
      target: { value: "terraform apply" },
    });
    expect((screen.getByRole("button", { name: /proceed/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /proceed/i }));
    expect(onApprove).toHaveBeenCalledOnce();
  });
});
