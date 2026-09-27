import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TerminalFixApprovalModal } from "./TerminalFixApprovalModal";
import type { TerminalFixPreview } from "../lib/tauri";

const preview: TerminalFixPreview = {
  lease_id: "lease-1",
  digest: "digest-1",
  target: {
    backendPtyId: "pty-1",
    terminalId: "term-1",
    source: "saved_ssh",
    connectionId: "connection-1",
    displayName: "Access switch",
  },
  summary: "Correct the RADIUS source interface",
  commands: ["ip radius source-interface Vlan10"],
  verification_commands: ["show aaa servers"],
  rollback_commands: ["no ip radius source-interface Vlan10"],
  highest_tier: "T1",
  per_command_tiers: [
    { command: "ip radius source-interface Vlan10", tier: "T1" },
  ],
};

describe("TerminalFixApprovalModal", () => {
  it("shows the locked target, exact commands, verification, rollback, and tiers", () => {
    render(
      <TerminalFixApprovalModal
        preview={preview}
        onReviewEdit={vi.fn()}
        onApprove={vi.fn()}
        onReject={vi.fn()}
      />,
    );
    expect(screen.getByText("Access switch")).toBeTruthy();
    expect(screen.getAllByText("ip radius source-interface Vlan10").length).toBeGreaterThan(0);
    expect(screen.getByText("show aaa servers")).toBeTruthy();
    expect(screen.getByText("no ip radius source-interface Vlan10")).toBeTruthy();
    expect(screen.getAllByText("T1").length).toBeGreaterThan(0);
  });

  it("requires edited commands to be reviewed again before approval", () => {
    const onReviewEdit = vi.fn();
    const onApprove = vi.fn();
    const { rerender } = render(
      <TerminalFixApprovalModal
        preview={preview}
        onReviewEdit={onReviewEdit}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("Fix commands"), {
      target: { value: "ip radius source-interface Vlan20" },
    });
    expect(screen.queryByRole("button", { name: "Approve exact batch" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review edited batch" }));
    expect(onReviewEdit).toHaveBeenCalledWith({
      summary: preview.summary,
      commands: ["ip radius source-interface Vlan20"],
      verification_commands: preview.verification_commands,
      rollback_commands: preview.rollback_commands,
    });
    expect(onApprove).not.toHaveBeenCalled();

    rerender(
      <TerminalFixApprovalModal
        preview={{
          ...preview,
          digest: "digest-2",
          commands: ["ip radius source-interface Vlan20"],
          per_command_tiers: [
            { command: "ip radius source-interface Vlan20", tier: "T1" },
          ],
        }}
        onReviewEdit={onReviewEdit}
        onApprove={onApprove}
        onReject={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Approve exact batch" }));
    expect(onApprove).toHaveBeenCalledOnce();
  });
});
