import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CommandCell } from "./CommandCell";
import { ApprovalCell } from "./ApprovalCell";
import { AssertionCell } from "./AssertionCell";
import { ParameterCell } from "./ParameterCell";
import { MarkdownCell } from "./MarkdownCell";

describe("CommandCell", () => {
  it("renders command body and status chip", () => {
    render(<CommandCell content="show ip bgp summary" status="passed" />);
    expect(screen.getByTestId("cell-command")).toBeInTheDocument();
    expect(screen.getByText("show ip bgp summary")).toBeInTheDocument();
    expect(screen.getByTestId("cell-status-chip").dataset.status).toBe("passed");
  });

  it("renders error when failed", () => {
    render(
      <CommandCell content="x" status="failed" error="exit code 1" />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("exit code 1");
  });
});

describe("ApprovalCell", () => {
  it("does not show buttons when not awaiting", () => {
    render(
      <ApprovalCell
        content="continue?"
        status="pending"
        isAwaiting={false}
        onApprove={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("approval-continue")).toBeNull();
  });

  it("calls onApprove when Continue is clicked while awaiting", () => {
    const onApprove = vi.fn();
    render(
      <ApprovalCell
        content="continue?"
        status="awaiting_approval"
        isAwaiting={true}
        onApprove={onApprove}
      />,
    );
    fireEvent.click(screen.getByTestId("approval-continue"));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it("calls onCancel when Cancel is clicked while awaiting", () => {
    const onCancel = vi.fn();
    render(
      <ApprovalCell
        content="continue?"
        status="awaiting_approval"
        isAwaiting={true}
        onApprove={vi.fn()}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByTestId("approval-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

describe("AssertionCell", () => {
  const spec = {
    command: "show version",
    jsonpath: "$.version",
    op: "equals" as const,
    expected: "17.09.04",
  };

  it("renders the spec fields", () => {
    render(<AssertionCell spec={spec} status="pending" />);
    expect(screen.getByText("show version")).toBeInTheDocument();
    expect(screen.getByText("$.version")).toBeInTheDocument();
    expect(screen.getByText('"17.09.04"')).toBeInTheDocument();
  });

  it("shows actual value when failed", () => {
    render(<AssertionCell spec={spec} status="failed" error='actual: "16.0"' />);
    expect(screen.getByRole("alert")).toHaveTextContent("16.0");
  });

  it("does not show error when passed", () => {
    render(<AssertionCell spec={spec} status="passed" error="should not show" />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("ParameterCell", () => {
  it("shows current values, falling back to default", () => {
    render(
      <ParameterCell
        params={[
          { name: "peer_ip", prompt: "Peer IP", default: "10.0.0.1" },
          { name: "peer_asn", prompt: "Peer ASN" },
        ]}
        values={{ peer_asn: "65001" }}
      />,
    );
    expect(screen.getByText("peer_ip")).toBeInTheDocument();
    // default
    expect(screen.getByText("10.0.0.1")).toBeInTheDocument();
    // explicit value
    expect(screen.getByText("65001")).toBeInTheDocument();
  });

  it("shows '(not set)' for params with no default and no value", () => {
    render(
      <ParameterCell
        params={[{ name: "x", prompt: "X" }]}
        values={{}}
      />,
    );
    expect(screen.getByText("(not set)")).toBeInTheDocument();
  });
});

describe("MarkdownCell", () => {
  it("renders markdown content", () => {
    render(<MarkdownCell content="# Hello\n\nworld" />);
    expect(screen.getByTestId("cell-markdown")).toBeInTheDocument();
  });
});
