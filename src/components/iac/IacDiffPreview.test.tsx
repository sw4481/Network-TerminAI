import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { IacDiffPreview } from "./IacDiffPreview";

// Monaco DiffEditor lazy-loads monaco (never resolves under jsdom); stub it to
// a sentinel that exposes the original/modified props for assertions.
vi.mock("@monaco-editor/react", () => ({
  DiffEditor: (props: { original: string; modified: string }) => (
    <div
      data-testid="diff-editor"
      data-original={props.original}
      data-modified={props.modified}
    />
  ),
}));

const proposal = {
  code: 'resource "aws_s3_bucket" "b" {}',
  filename: "s3.tf",
  explanation: "an s3 bucket",
  validation: { valid: true, skipped: false, error: null },
};

describe("IacDiffPreview", () => {
  it("renders the diff with current buffer as original and proposal as modified", () => {
    render(
      <IacDiffPreview
        original="# old"
        proposal={proposal}
        language="hcl"
        onAccept={() => {}}
        onReject={() => {}}
      />,
    );
    const diff = screen.getByTestId("diff-editor");
    expect(diff.getAttribute("data-original")).toBe("# old");
    expect(diff.getAttribute("data-modified")).toBe(proposal.code);
  });

  it("shows the explanation and filename", () => {
    render(
      <IacDiffPreview original="" proposal={proposal} language="hcl" onAccept={() => {}} onReject={() => {}} />,
    );
    expect(screen.getByText(/an s3 bucket/)).toBeInTheDocument();
    expect(screen.getByText(/s3\.tf/)).toBeInTheDocument();
  });

  it("calls onAccept when Accept is clicked", () => {
    const onAccept = vi.fn();
    render(
      <IacDiffPreview original="" proposal={proposal} language="hcl" onAccept={onAccept} onReject={() => {}} />,
    );
    fireEvent.click(screen.getByTestId("iac-diff-accept"));
    expect(onAccept).toHaveBeenCalledOnce();
  });

  it("calls onReject when Reject is clicked", () => {
    const onReject = vi.fn();
    render(
      <IacDiffPreview original="" proposal={proposal} language="hcl" onAccept={() => {}} onReject={onReject} />,
    );
    fireEvent.click(screen.getByTestId("iac-diff-reject"));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it("shows an honest 'not validated' note when validation was skipped", () => {
    render(
      <IacDiffPreview
        original=""
        proposal={{ ...proposal, validation: { valid: null, skipped: true, error: null } }}
        language="hcl"
        onAccept={() => {}}
        onReject={() => {}}
      />,
    );
    expect(screen.getByText(/syntax not validated/i)).toBeInTheDocument();
  });

  it("calls onReject when Escape is pressed", () => {
    const onReject = vi.fn();
    render(
      <IacDiffPreview original="" proposal={proposal} language="hcl" onAccept={() => {}} onReject={onReject} />,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onReject).toHaveBeenCalledOnce();
  });
});
