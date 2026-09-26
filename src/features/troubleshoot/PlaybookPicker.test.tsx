/**
 * Plan 15 Phase 5 — PlaybookPicker matcher integration.
 *
 * Covers the new ranked-suggestions surface introduced by Phase 5.
 * Earlier Phase 4 picker behaviours (manual list selection, vars JSON
 * validation, start_run dispatch) are exercised indirectly here and
 * directly in `TreeCanvas.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";

/** Real-time helper. We use real timers because `waitFor` polls on
 * real time; fake timers + waitFor deadlock. The picker debounces
 * 300ms; 350ms is enough to let it fire. */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { PlaybookPicker, extractTemplateVars } from "./PlaybookPicker";
import { useTroubleshootStore } from "./store";
import type { MatchResult, PlaybookMeta } from "./api";

const seedPlaybooks: PlaybookMeta[] = [
  {
    id: "bgp-wont-peer",
    name: "BGP session will not peer",
    vendor: "cisco",
    platform: "iosxe",
    symptom_keywords: ["bgp", "neighbor", "peer"],
    builtin: true,
    created_at: 0,
    updated_at: 0,
  },
  {
    id: "ospf-neighbor-init",
    name: "OSPF neighbor stuck in Init or ExStart",
    vendor: "cisco",
    platform: "iosxe",
    symptom_keywords: ["ospf", "neighbor", "init"],
    builtin: true,
    created_at: 0,
    updated_at: 0,
  },
];

function setupListPlaybooksMock() {
  invokeMock.mockImplementation(async (cmd: string, _args?: unknown) => {
    if (cmd === "list_playbooks") return seedPlaybooks;
    if (cmd === "match_symptom") return [] as MatchResult[];
    if (cmd === "ssh_list_connections") return [];
    if (cmd === "ssh_decrypt_password") return "testpass123";
    return null;
  });
}

beforeEach(() => {
  invokeMock.mockReset();
  useTroubleshootStore.getState().reset();
});

describe("PlaybookPicker — Phase 5 matcher integration", () => {
  it("renders the existing manual list when no symptom is typed", async () => {
    setupListPlaybooksMock();
    await act(async () => {
      render(<PlaybookPicker tabId="t1" />);
    });
    // After list_playbooks resolves the manual list shows builtins.
    await waitFor(() =>
      expect(screen.getByTestId("tb-picker-row-bgp-wont-peer")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("tb-picker-matches")).toBeNull();
  });

  it("calls match_symptom 300ms after typing and renders ranked suggestions", async () => {
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_playbooks") return seedPlaybooks;
      if (cmd === "ssh_list_connections") return [];
      if (cmd === "match_symptom") {
        // Sanity-check the args plumb through unchanged.
        const argsObj = args as Record<string, unknown>;
        expect(argsObj.symptom).toBe("BGP neighbor stuck in Idle");
        expect(argsObj.vendor).toBeNull();
        expect(argsObj.platform).toBeNull();
        return [
          {
            id: "bgp-wont-peer",
            score: 0.78,
            reasons: ["keyword 'bgp' matched", "keyword 'neighbor' matched"],
          },
          {
            id: "ospf-neighbor-init",
            score: 0.41,
            reasons: ["keyword 'neighbor' matched"],
          },
        ] as MatchResult[];
      }
      return null;
    });

    await act(async () => {
      render(<PlaybookPicker tabId="t1" />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("tb-picker-row-bgp-wont-peer")).toBeInTheDocument(),
    );

    const symptom = screen.getByTestId("tb-picker-symptom") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(symptom, {
        target: { value: "BGP neighbor stuck in Idle" },
      });
    });

    // No matcher call before debounce.
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "match_symptom").length,
    ).toBe(0);

    await act(async () => {
      await sleep(360);
    });

    // Matcher fired and rendered both rows.
    await waitFor(() => {
      expect(screen.getByTestId("tb-picker-match-bgp-wont-peer")).toBeInTheDocument();
    });
    expect(screen.getByTestId("tb-picker-match-bgp-wont-peer")).toHaveTextContent(
      "BGP session will not peer",
    );
    expect(
      screen.getByTestId("tb-picker-match-score-bgp-wont-peer"),
    ).toHaveTextContent("78%");
    expect(screen.getByTestId("tb-picker-match-ospf-neighbor-init")).toBeInTheDocument();
  });

  it("clicking a match selects the playbook (does not auto-start)", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return seedPlaybooks;
      if (cmd === "ssh_list_connections") return [];
      if (cmd === "match_symptom")
        return [
          {
            id: "bgp-wont-peer",
            score: 0.7,
            reasons: ["keyword 'bgp' matched"],
          },
        ] as MatchResult[];
      return null;
    });

    await act(async () => {
      render(<PlaybookPicker tabId="t1" />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("tb-picker-row-bgp-wont-peer")).toBeInTheDocument(),
    );
    const symptom = screen.getByTestId("tb-picker-symptom") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(symptom, { target: { value: "BGP idle" } });
    });
    await act(async () => {
      await sleep(360);
    });
    await waitFor(() =>
      expect(screen.getByTestId("tb-picker-match-bgp-wont-peer")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("tb-picker-match-bgp-wont-peer"));
    });
    // Selection is reflected on the matching row.
    expect(
      screen
        .getByTestId("tb-picker-match-bgp-wont-peer")
        .getAttribute("data-selected"),
    ).toBe("true");
    // start_run was NOT invoked — the operator still has to press Start.
    expect(
      invokeMock.mock.calls.filter((c) => c[0] === "start_run").length,
    ).toBe(0);
    // The Start button is enabled now though.
    expect(
      (screen.getByTestId("tb-picker-start") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("renders the no-match panel when top score is below 0.35", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return seedPlaybooks;
      if (cmd === "ssh_list_connections") return [];
      if (cmd === "match_symptom")
        return [
          {
            id: "bgp-wont-peer",
            score: 0.18,
            reasons: ["keyword 'bgp' matched"],
          },
        ] as MatchResult[];
      return null;
    });
    await act(async () => {
      render(<PlaybookPicker tabId="t1" />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("tb-picker-row-bgp-wont-peer")).toBeInTheDocument(),
    );
    const symptom = screen.getByTestId("tb-picker-symptom") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(symptom, {
        target: { value: "purple monkey dishwasher" },
      });
    });
    await act(async () => {
      await sleep(360);
    });
    await waitFor(() =>
      expect(screen.getByTestId("tb-picker-no-match")).toBeInTheDocument(),
    );
    // Generate-with-AI button is disabled until Phase 6.
    const generate = screen.getByTestId("tb-picker-generate-ai") as HTMLButtonElement;
    expect(generate.disabled).toBe(true);
    // Sub-threshold matches do NOT render as ranked rows.
    expect(screen.queryByTestId("tb-picker-match-bgp-wont-peer")).toBeNull();
  });

  it("shows device selector with SSH connections", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return seedPlaybooks;
      if (cmd === "match_symptom") return [] as MatchResult[];
      if (cmd === "ssh_list_connections") return [
        { id: "ssh-1", name: "Router1", host: "10.1.1.1", user: "admin", port: 22, password_encrypted: "encrypted_pass_1" },
        { id: "ssh-2", name: "Switch1", host: "10.1.1.2", user: "admin", port: 22, password_encrypted: "encrypted_pass_2" },
      ];
      return null;
    });
    await act(async () => {
      render(<PlaybookPicker tabId="t1" />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("tb-target-current-tab")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("tb-target-ssh")).toBeInTheDocument();
    const currentTabRadio = screen.getByTestId("tb-target-current-tab") as HTMLInputElement;
    expect(currentTabRadio.checked).toBe(true);
  });

  it("surfaces matcher errors without breaking the manual list", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks") return seedPlaybooks;
      if (cmd === "match_symptom") throw new Error("sidecar down");
      if (cmd === "ssh_list_connections") return [];
      return null;
    });
    await act(async () => {
      render(<PlaybookPicker tabId="t1" />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("tb-picker-row-bgp-wont-peer")).toBeInTheDocument(),
    );
    const symptom = screen.getByTestId("tb-picker-symptom") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(symptom, { target: { value: "anything" } });
    });
    await act(async () => {
      await sleep(360);
    });
    await waitFor(() =>
      expect(screen.getByTestId("tb-picker-match-error")).toBeInTheDocument(),
    );
    // Manual list still selectable.
    await act(async () => {
      fireEvent.click(screen.getByTestId("tb-picker-row-bgp-wont-peer"));
    });
    expect(
      (screen.getByTestId("tb-picker-start") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("forwards vendor + platform to match_symptom when provided", async () => {
    let captured: Record<string, unknown> | null = null;
    invokeMock.mockImplementation(async (cmd: string, args?: unknown) => {
      if (cmd === "list_playbooks") return seedPlaybooks;
      if (cmd === "ssh_list_connections") return [];
      if (cmd === "match_symptom") {
        captured = args as Record<string, unknown>;
        return [] as MatchResult[];
      }
      return null;
    });
    await act(async () => {
      render(<PlaybookPicker tabId="t1" vendor="cisco" platform="iosxe" />);
    });
    await waitFor(() =>
      expect(screen.getByTestId("tb-picker-row-bgp-wont-peer")).toBeInTheDocument(),
    );
    const symptom = screen.getByTestId("tb-picker-symptom") as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(symptom, { target: { value: "bgp" } });
    });
    await act(async () => {
      await sleep(360);
    });
    expect(captured).toBeTruthy();
    expect(captured!.vendor).toBe("cisco");
    expect(captured!.platform).toBe("iosxe");
  });

  it("extractTemplateVars finds unique {{vars}} in first-seen order", () => {
    const yaml = `steps:
  - command: show ip interface {{intf}}
  - command: show ip route {{neighbor}}
  - text: "{{intf}} again"`;
    expect(extractTemplateVars(yaml)).toEqual(["intf", "neighbor"]);
    expect(extractTemplateVars("no vars here")).toEqual([]);
  });

  it("renders a labeled input per required {{var}} and gates Start until filled", async () => {
    const yamlBody = `id: needs-intf
name: Needs intf
symptom_keywords: [intf]
vendor: cisco
platform: iosxe
steps:
  - id: check_intf
    type: command
    command: show ip interface {{intf}}`;
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "list_playbooks")
        return [
          {
            id: "needs-intf",
            name: "Needs intf",
            vendor: "cisco",
            platform: "iosxe",
            symptom_keywords: ["intf"],
            builtin: true,
            created_at: 0,
            updated_at: 0,
          },
        ];
      if (cmd === "get_playbook") return yamlBody;
      if (cmd === "ssh_list_connections") return [];
      if (cmd === "match_symptom") return [] as MatchResult[];
      return null;
    });

    await act(async () => {
      render(<PlaybookPicker tabId="t1" />);
    });
    // Select the playbook.
    await waitFor(() =>
      expect(screen.getByTestId("tb-picker-row-needs-intf")).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("tb-picker-row-needs-intf"));
    });

    // The intf field appears and Start is disabled while it's empty.
    await waitFor(() =>
      expect(screen.getByTestId("tb-picker-var-intf")).toBeInTheDocument(),
    );
    expect(
      (screen.getByTestId("tb-picker-start") as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByTestId("tb-picker-var-hint")).toBeInTheDocument();

    // Fill it in → Start enables.
    await act(async () => {
      fireEvent.change(screen.getByTestId("tb-picker-var-intf"), {
        target: { value: "GigabitEthernet1/0/1" },
      });
    });
    await waitFor(() =>
      expect(
        (screen.getByTestId("tb-picker-start") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });
});
