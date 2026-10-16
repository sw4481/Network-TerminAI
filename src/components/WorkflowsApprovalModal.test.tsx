import { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkflowsApprovalModal } from "./WorkflowsApprovalModal";

const request = {
  tier: "high" as const,
  method: "POST",
  path: "/v1/workflows/create",
  organizationId: "synthetic-org",
  params: { method: "POST", organization_id: "synthetic-org", body: { actions: [] } },
  rationale: "Create a synthetic workflow",
};

function renderApproval(disableOpenerOnOpen = false, returnToChat = false) {
  const onApprove = vi.fn();
  const onDeny = vi.fn();
  function Harness() {
    const [open, setOpen] = useState(false);
    const [openerDisabled, setOpenerDisabled] = useState(false);
    const openerRef = useRef<HTMLButtonElement>(null);
    const fallbackRef = useRef<HTMLButtonElement>(null);
    return <>
      <button ref={openerRef} type="button" disabled={openerDisabled} onClick={() => {
        setOpen(true);
        if (disableOpenerOnOpen) setOpenerDisabled(true);
      }}>Open review</button>
      <button ref={fallbackRef} type="button">Chat control</button>
      {open && <WorkflowsApprovalModal
        request={request}
        returnFocusRef={disableOpenerOnOpen || returnToChat ? fallbackRef : openerRef}
        onApprove={() => { onApprove(); setOpen(false); }}
        onDeny={() => { onDeny(); setOpen(false); }}
      />}
    </>;
  }
  const user = userEvent.setup();
  render(<Harness />);
  return { user, onApprove, onDeny };
}

describe("WorkflowsApprovalModal keyboard safety", () => {
  it("focuses Deny and keeps forward and reverse Tab inside the review", async () => {
    const { user, onApprove, onDeny } = renderApproval();
    await user.click(screen.getByRole("button", { name: "Open review" }));
    const deny = screen.getByRole("button", { name: "Deny" });
    const approve = screen.getByRole("button", { name: "Approve exact change" });

    expect(deny).toHaveFocus();
    await user.tab();
    expect(approve).toHaveFocus();
    await user.tab();
    expect(deny).toHaveFocus();
    await user.tab({ shift: true });
    expect(approve).toHaveFocus();
    expect(onApprove).not.toHaveBeenCalled();
    expect(onDeny).not.toHaveBeenCalled();
  });

  it("Escape denies even when Approve has focus and restores the opener", async () => {
    const { user, onApprove, onDeny } = renderApproval();
    const opener = screen.getByRole("button", { name: "Open review" });
    await user.click(opener);
    await user.tab();
    expect(screen.getByRole("button", { name: "Approve exact change" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(onDeny).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("an explicit approval restores the opener after the review closes", async () => {
    const { user, onApprove, onDeny } = renderApproval();
    const opener = screen.getByRole("button", { name: "Open review" });
    await user.click(opener);
    await user.tab();
    await user.keyboard("{Enter}");

    expect(onApprove).toHaveBeenCalledOnce();
    expect(onDeny).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it("prefers the supplied stable return target even if the opener stays enabled", async () => {
    const { user, onApprove, onDeny } = renderApproval(false, true);
    const opener = screen.getByRole("button", { name: "Open review" });
    const chatControl = screen.getByRole("button", { name: "Chat control" });
    await user.click(opener);
    expect(opener).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(onDeny).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
    expect(chatControl).toHaveFocus();
  });

  it("returns focus to the chat control when the previous opener becomes disabled", async () => {
    const { user, onApprove, onDeny } = renderApproval(true);
    const opener = screen.getByRole("button", { name: "Open review" });
    const fallback = screen.getByRole("button", { name: "Chat control" });
    await user.click(opener);
    expect(opener).toBeDisabled();
    expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Deny" }));
    expect(onDeny).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
    expect(fallback).toHaveFocus();
  });

  it("clicking Deny also restores the opener without approving", async () => {
    const { user, onApprove, onDeny } = renderApproval();
    const opener = screen.getByRole("button", { name: "Open review" });
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Deny" }));

    expect(onDeny).toHaveBeenCalledOnce();
    expect(onApprove).not.toHaveBeenCalled();
    expect(opener).toHaveFocus();
  });
});
