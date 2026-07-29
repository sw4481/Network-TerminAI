import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DecisionLogView } from "./DecisionLogView";
import { decisionsToCsv } from "../../lib/guardrails";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

const sampleDecisions = [
  {
    id: "d1",
    session_id: "session-A",
    command: "show version",
    tier: 0,
    rule_id: "builtin-iosxe-show-version",
    decision: "auto_approved",
    user_action: "proceed",
    reasoning: "Read-only",
    decided_at: 1716000000,
  },
  {
    id: "d2",
    session_id: "session-B",
    command: "reload",
    tier: 3,
    rule_id: "builtin-iosxe-reload",
    decision: "admin_override",
    user_action: "proceed",
    reasoning: "Full reload",
    decided_at: 1716000100,
  },
];

beforeEach(() => {
  mockedInvoke.mockReset();
  mockedInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === "guardrail_decisions_list") return sampleDecisions;
    return null;
  });
});

describe("DecisionLogView", () => {
  it("lists decisions with tier badges", async () => {
    render(<DecisionLogView />);
    await waitFor(() => screen.getByTestId("dl-row-d1"));
    expect(screen.getByTestId("dl-row-d1")).toHaveTextContent("show version");
    expect(screen.getByTestId("dl-row-d2")).toHaveTextContent("reload");
  });

  it("filters by tier", async () => {
    render(<DecisionLogView />);
    await waitFor(() => screen.getByTestId("dl-row-d1"));
    fireEvent.change(screen.getByTestId("dl-tier"), { target: { value: "3" } });
    expect(screen.queryByTestId("dl-row-d1")).toBeNull();
    expect(screen.getByTestId("dl-row-d2")).toBeInTheDocument();
  });

  it("filters by decision label", async () => {
    render(<DecisionLogView />);
    await waitFor(() => screen.getByTestId("dl-row-d1"));
    fireEvent.change(screen.getByTestId("dl-decision"), {
      target: { value: "admin_override" },
    });
    expect(screen.queryByTestId("dl-row-d1")).toBeNull();
    expect(screen.getByTestId("dl-row-d2")).toBeInTheDocument();
  });

  it("filters by session id substring", async () => {
    render(<DecisionLogView />);
    await waitFor(() => screen.getByTestId("dl-row-d1"));
    fireEvent.change(screen.getByTestId("dl-session"), { target: { value: "ssion-B" } });
    expect(screen.queryByTestId("dl-row-d1")).toBeNull();
    expect(screen.getByTestId("dl-row-d2")).toBeInTheDocument();
  });
});

describe("decisionsToCsv", () => {
  it("emits header + rows with proper CSV escaping", () => {
    const csv = decisionsToCsv([
      {
        id: "d1",
        session_id: "s,1",
        command: 'echo "hi"',
        tier: 1,
        rule_id: null,
        decision: "confirmed",
        user_action: "proceed",
        reasoning: "needs\nquoting",
        decided_at: 1716000000,
      },
    ]);
    const lines = csv.split("\n");
    expect(lines[0]).toBe(
      "id,session_id,command,tier,rule_id,decision,user_action,reasoning,decided_at",
    );
    expect(lines[1]).toContain('"s,1"'); // comma escaped
    expect(lines[1]).toContain('"echo ""hi"""'); // double-quote escaped
    // Newlines inside a quoted field break the line split, so the
    // multi-line cell shows up as a continuation line:
    expect(csv).toContain('"needs\nquoting"');
  });
});
