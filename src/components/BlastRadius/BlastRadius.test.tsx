import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { ToastAutoApproved } from "./ToastAutoApproved";
import { OneClickModal } from "./OneClickModal";
import { TypedConfirmModal } from "./TypedConfirmModal";
import { MaintenanceWindowModal } from "./MaintenanceWindowModal";
import { BlastRadiusHost } from "./BlastRadiusHost";
import { useGuardrailsStore } from "../../state/guardrailsStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => "decision-id-stub"),
}));

beforeEach(() => {
  useGuardrailsStore.setState({ pending: [] });
});

describe("ToastAutoApproved", () => {
  it("renders the command then dismisses", () => {
    vi.useFakeTimers();
    const onDismissed = vi.fn();
    render(<ToastAutoApproved command="show version" durationMs={1500} onDismissed={onDismissed} />);
    expect(screen.getByTestId("br-toast-auto-approved")).toHaveTextContent("show version");
    act(() => {
      vi.advanceTimersByTime(1600);
    });
    expect(onDismissed).toHaveBeenCalled();
    vi.useRealTimers();
  });
});

describe("OneClickModal (Tier 1)", () => {
  it("renders the command and reasoning, fires onProceed on Enter", () => {
    const onProceed = vi.fn();
    const onCancel = vi.fn();
    render(
      <OneClickModal
        command="hostname R99"
        reasoning="Hostname change"
        vendor="cisco"
        platform="iosxe"
        onProceed={onProceed}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByText("hostname R99")).toBeInTheDocument();
    expect(screen.getByText("Hostname change")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onProceed).toHaveBeenCalled();
  });

  it("fires onCancel on Escape", () => {
    const onProceed = vi.fn();
    const onCancel = vi.fn();
    render(
      <OneClickModal
        command="hostname R99"
        reasoning=""
        vendor="cisco"
        platform="iosxe"
        onProceed={onProceed}
        onCancel={onCancel}
      />,
    );
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("TypedConfirmModal (Tier 2)", () => {
  it("disables Proceed until the command is typed exactly", () => {
    const onProceed = vi.fn();
    render(
      <TypedConfirmModal
        command="shutdown"
        reasoning="Iface shutdown"
        vendor="cisco"
        platform="iosxe"
        onProceed={onProceed}
        onCancel={() => {}}
      />,
    );
    const btn = screen.getByTestId("br-proceed") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    const input = screen.getByTestId("br-typed-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "shutdown" } });
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onProceed).toHaveBeenCalled();
  });

  it("respects the challenge phrase when provided", () => {
    render(
      <TypedConfirmModal
        command="set interfaces ge-0/0/5 disable"
        challenge="shutdown ge-0/0/5"
        reasoning=""
        vendor="juniper"
        platform="junos"
        onProceed={() => {}}
        onCancel={() => {}}
      />,
    );
    const btn = screen.getByTestId("br-proceed") as HTMLButtonElement;
    fireEvent.change(screen.getByTestId("br-typed-input"), {
      target: { value: "set interfaces ge-0/0/5 disable" },
    });
    expect(btn.disabled).toBe(true); // wrong text — must match challenge, not full command
    fireEvent.change(screen.getByTestId("br-typed-input"), {
      target: { value: "shutdown ge-0/0/5" },
    });
    expect(btn.disabled).toBe(false);
  });

  it("shows topology fallback when impact is missing", () => {
    render(
      <TypedConfirmModal
        command="shutdown"
        reasoning=""
        vendor="cisco"
        platform="iosxe"
        onProceed={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByTestId("br-impact").textContent).toMatch(/topology/i);
  });
});

describe("MaintenanceWindowModal (Tier 3)", () => {
  it("requires a window selection or override+reason to proceed", () => {
    const onProceed = vi.fn();
    render(
      <MaintenanceWindowModal
        command="reload"
        reasoning="Full reload"
        vendor="cisco"
        platform="iosxe"
        windows={[
          { id: "w1", label: "Tonight 02:00", startsAt: 1, endsAt: 2 },
        ]}
        onProceed={onProceed}
        onCancel={() => {}}
      />,
    );
    const btn = screen.getByTestId("br-proceed") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    fireEvent.click(screen.getByTestId("br-mw-w1"));
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(onProceed).toHaveBeenCalledWith({ mode: "window", windowId: "w1" });
  });

  it("requires ≥20 chars for admin override reason", () => {
    const onProceed = vi.fn();
    render(
      <MaintenanceWindowModal
        command="reload"
        reasoning=""
        vendor="cisco"
        platform="iosxe"
        windows={[]}
        onProceed={onProceed}
        onCancel={() => {}}
      />,
    );
    const btn = screen.getByTestId("br-proceed") as HTMLButtonElement;
    fireEvent.click(screen.getByTestId("br-override-toggle"));
    fireEvent.change(screen.getByTestId("br-override-reason"), {
      target: { value: "too short" },
    });
    expect(btn.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("br-override-reason"), {
      target: { value: "P1 incident remediation, ticket INC-1234" },
    });
    expect(btn.disabled).toBe(false);
  });
});

describe("BlastRadiusHost queue", () => {
  it("returns null when queue is empty", () => {
    const { container } = render(<BlastRadiusHost />);
    expect(container.firstChild).toBeNull();
  });

  it("routes T1 to OneClickModal, advances on resolve", async () => {
    render(<BlastRadiusHost />);
    let resolved: string | null = null;
    await act(async () => {
      void useGuardrailsStore
        .getState()
        .enqueueAndAwait({
          pendingId: "p1",
          tier: "T1",
          command: "hostname R99",
          reasoning: "Hostname change",
          vendor: "cisco",
          platform: "iosxe",
          sessionId: "s1",
          ruleId: null,
        })
        .then((r) => (resolved = r));
    });

    expect(screen.getByTestId("br-overlay-tier1")).toBeInTheDocument();
    await act(async () => {
      await useGuardrailsStore.getState().resolve("proceed");
    });
    expect(resolved).toBe("proceed");
    expect(useGuardrailsStore.getState().pending.length).toBe(0);
  });

  it("routes T3 to MaintenanceWindowModal", async () => {
    render(<BlastRadiusHost />);
    await act(async () => {
      void useGuardrailsStore.getState().enqueueAndAwait({
        pendingId: "p2",
        tier: "T3",
        command: "reload",
        reasoning: "Full reload",
        vendor: "cisco",
        platform: "iosxe",
        sessionId: "s1",
        ruleId: null,
      });
    });
    expect(screen.getByTestId("br-overlay-tier3")).toBeInTheDocument();
  });

  it("routes Ambiguous to TypedConfirmModal (typed-confirm gating)", async () => {
    render(<BlastRadiusHost />);
    await act(async () => {
      void useGuardrailsStore.getState().enqueueAndAwait({
        pendingId: "p3",
        tier: "Ambiguous",
        command: "archive path disk0:foo.cfg",
        reasoning: "No rule matched",
        vendor: "cisco",
        platform: "iosxe",
        sessionId: "s1",
        ruleId: null,
      });
    });
    expect(screen.getByTestId("br-overlay-tier2")).toBeInTheDocument();
  });
});
