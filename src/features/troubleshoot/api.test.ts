import { describe, it, expect, vi, beforeEach } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  useTroubleshootStore,
  selectActiveRun,
  selectOrderedNarration,
  selectOrderedSteps,
} from "./store";
import type {
  PlaybookMeta,
  RunDetails,
  StepUpdateEvent,
  StatusEvent,
  NarrationEvent,
  ConclusionEvent,
  UserPromptEvent,
} from "./api";

beforeEach(() => {
  invokeMock.mockReset();
  useTroubleshootStore.getState().reset();
});

describe("troubleshoot store — playbooks", () => {
  it("refreshPlaybooks loads from list_playbooks", async () => {
    const meta: PlaybookMeta[] = [
      {
        id: "bgp-wont-peer",
        name: "BGP session will not peer",
        vendor: "cisco",
        platform: "iosxe",
        symptom_keywords: ["bgp"],
        builtin: true,
        created_at: 0,
        updated_at: 0,
      },
    ];
    invokeMock.mockResolvedValue(meta);
    await useTroubleshootStore.getState().refreshPlaybooks();
    expect(invokeMock).toHaveBeenCalledWith("list_playbooks");
    expect(useTroubleshootStore.getState().playbooks).toEqual(meta);
    expect(useTroubleshootStore.getState().loadingPlaybooks).toBe(false);
  });

  it("captures playbooksError when invoke rejects", async () => {
    invokeMock.mockRejectedValue(new Error("db locked"));
    await useTroubleshootStore.getState().refreshPlaybooks();
    expect(useTroubleshootStore.getState().playbooksError).toContain("db locked");
  });
});

describe("troubleshoot store — startRun lifecycle", () => {
  it("seeds a run and sets activeRunId", async () => {
    invokeMock.mockResolvedValue("run-1");
    const id = await useTroubleshootStore.getState().startRun({
      playbookId: "bgp-wont-peer",
      tabId: "tab-7",
      symptom: "neighbor stuck idle",
      vars: { neighbor: "10.0.0.5" },
    });
    expect(id).toBe("run-1");
    const state = useTroubleshootStore.getState();
    expect(state.activeRunId).toBe("run-1");
    const run = state.runs["run-1"];
    expect(run.symptom).toBe("neighbor stuck idle");
    expect(run.status).toBe("running");
    expect(invokeMock).toHaveBeenCalledWith("start_run", {
      playbookId: "bgp-wont-peer",
      tabId: "tab-7",
      symptom: "neighbor stuck idle",
      vars: { neighbor: "10.0.0.5" },
      connectionId: undefined,
      password: undefined,
    });
  });

  it("forwards SSH connection id + password when supplied (Plan 15 over SSH)", async () => {
    invokeMock.mockResolvedValue("run-2");
    await useTroubleshootStore.getState().startRun({
      playbookId: "bgp-wont-peer",
      tabId: "tab-7",
      symptom: "neighbor stuck idle",
      vars: {},
      connectionId: "conn-1",
      password: "pw",
    });
    expect(invokeMock).toHaveBeenCalledWith("start_run", {
      playbookId: "bgp-wont-peer",
      tabId: "tab-7",
      symptom: "neighbor stuck idle",
      vars: {},
      connectionId: "conn-1",
      password: "pw",
    });
  });
});

describe("troubleshoot store — event fan-in", () => {
  it("applyStepEvent inserts a step and orders by idx", () => {
    const ev: StepUpdateEvent = {
      run_id: "r1",
      step: { step_id: "check_state", idx: 0, status: "running", result_json: null },
      step_type: "command",
    };
    useTroubleshootStore.getState().applyStepEvent(ev);
    const run = useTroubleshootStore.getState().runs["r1"];
    expect(run).toBeDefined();
    expect(selectOrderedSteps(run)).toHaveLength(1);
    expect(selectOrderedSteps(run)[0].step_ref).toBe("check_state");
    expect(selectOrderedSteps(run)[0].status).toBe("running");
  });

  it("applyStepEvent sets pendingPrompt when status awaiting_user", () => {
    const ev: StepUpdateEvent = {
      run_id: "r1",
      step: {
        step_id: "confirm_debug",
        idx: 2,
        status: "awaiting_user",
        result_json: { prompt: "Run debug? (Tier-1)" },
      },
      step_type: "command",
    };
    useTroubleshootStore.getState().applyStepEvent(ev);
    const run = useTroubleshootStore.getState().runs["r1"];
    expect(run.pendingPrompt).toEqual({
      stepId: "confirm_debug",
      prompt: "Run debug? (Tier-1)",
    });
  });

  it("applyStatusEvent flips status and clears pendingPrompt on terminal", () => {
    useTroubleshootStore.getState().applyUserPromptEvent({
      run_id: "r1",
      step_id: "p1",
      prompt: "go?",
    } as UserPromptEvent);
    expect(
      useTroubleshootStore.getState().runs["r1"].pendingPrompt?.stepId,
    ).toBe("p1");

    const status: StatusEvent = { run_id: "r1", status: "completed" };
    useTroubleshootStore.getState().applyStatusEvent(status);
    const run = useTroubleshootStore.getState().runs["r1"];
    expect(run.status).toBe("completed");
    expect(run.pendingPrompt).toBeNull();
  });

  it("applyStatusEvent records a cancel reason", () => {
    useTroubleshootStore.getState().applyStatusEvent({
      run_id: "r1",
      status: "failed",
      reason: "cancelled",
    });
    expect(useTroubleshootStore.getState().runs["r1"].cancelReason).toBe(
      "cancelled",
    );
  });

  it("applyConclusionEvent stores the conclusion payload", () => {
    const ev: ConclusionEvent = {
      run_id: "r1",
      conclusion: {
        root_cause: "BGP shutdown",
        confidence: "high",
        suggested_fix: "no neighbor 10.0.0.5 shutdown",
        evidence: ["step 2"],
      },
    };
    useTroubleshootStore.getState().applyConclusionEvent(ev);
    expect(useTroubleshootStore.getState().runs["r1"].conclusion).toEqual(
      ev.conclusion,
    );
  });

  it("applyUserPromptEvent populates pendingPrompt", () => {
    const ev: UserPromptEvent = {
      run_id: "r1",
      step_id: "approve_debug",
      prompt: "Approve debug bgp updates?",
    };
    useTroubleshootStore.getState().applyUserPromptEvent(ev);
    expect(
      useTroubleshootStore.getState().runs["r1"].pendingPrompt,
    ).toEqual({
      stepId: "approve_debug",
      prompt: "Approve debug bgp updates?",
    });
  });
});

describe("troubleshoot store — narration reconciliation", () => {
  it("merges legacy and Phase 3 narration shapes for the same step", () => {
    const legacy: NarrationEvent = {
      run_id: "r1",
      step_id: "narrate_admin",
      text: "Neighbor is admin shut.",
    };
    const enriched: NarrationEvent = {
      run_id: "r1",
      step_id: "narrate_admin",
      step_idx: 4,
      text: "Neighbor is admin shut. Run no shutdown.",
      citations: ["chunk-a", "chunk-b"],
    };
    useTroubleshootStore.getState().applyNarrationEvent(legacy);
    useTroubleshootStore.getState().applyNarrationEvent(enriched);

    const run = useTroubleshootStore.getState().runs["r1"];
    const entries = selectOrderedNarration(run);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.text).toBe("Neighbor is admin shut. Run no shutdown.");
    expect(e.stepIdx).toBe(4);
    expect(e.citations.sort()).toEqual(["chunk-a", "chunk-b"]);
  });

  it("orders narration entries by step_idx ascending", () => {
    useTroubleshootStore.getState().applyNarrationEvent({
      run_id: "r1",
      step_id: "s2",
      step_idx: 2,
      text: "second",
    });
    useTroubleshootStore.getState().applyNarrationEvent({
      run_id: "r1",
      step_id: "s0",
      step_idx: 0,
      text: "first",
    });
    const run = useTroubleshootStore.getState().runs["r1"];
    const entries = selectOrderedNarration(run);
    expect(entries.map((e) => e.text)).toEqual(["first", "second"]);
  });

  it("preserves entries with no step_idx (sort to end)", () => {
    useTroubleshootStore.getState().applyNarrationEvent({
      run_id: "r1",
      step_id: "s_with_idx",
      step_idx: 0,
      text: "indexed",
    });
    useTroubleshootStore.getState().applyNarrationEvent({
      run_id: "r1",
      step_id: "s_legacy",
      text: "legacy",
    });
    const run = useTroubleshootStore.getState().runs["r1"];
    const entries = selectOrderedNarration(run);
    expect(entries.map((e) => e.text)).toEqual(["indexed", "legacy"]);
  });
});

describe("troubleshoot store — selectors", () => {
  it("selectActiveRun returns null when no active id", () => {
    const r = selectActiveRun(useTroubleshootStore.getState());
    expect(r).toBeNull();
  });

  it("selectActiveRun returns the active run", () => {
    useTroubleshootStore.getState().applyStatusEvent({
      run_id: "r1",
      status: "running",
    });
    useTroubleshootStore.getState().setActiveRun("r1");
    const r = selectActiveRun(useTroubleshootStore.getState());
    expect(r?.runId).toBe("r1");
  });
});

describe("troubleshoot store — hydration", () => {
  it("hydrateRun loads steps and conclusion from get_run", async () => {
    const details: RunDetails = {
      run_id: "r2",
      playbook_id: "bgp-wont-peer",
      tab_id: "tab-1",
      symptom: "won't peer",
      status: "completed",
      started_at: 100,
      ended_at: 200,
      conclusion_json: {
        root_cause: "shutdown",
        confidence: "high",
        suggested_fix: "no shutdown",
        evidence: [],
      },
      steps: [
        {
          idx: 0,
          step_type: "command",
          step_ref: "check_state",
          status: "passed",
          result_json: null,
        },
        {
          idx: 1,
          step_type: "narration",
          step_ref: "narrate_ok",
          status: "passed",
          result_json: null,
        },
      ],
    };
    invokeMock.mockResolvedValue(details);
    await useTroubleshootStore.getState().hydrateRun("r2");
    const run = useTroubleshootStore.getState().runs["r2"];
    expect(run.symptom).toBe("won't peer");
    expect(run.status).toBe("completed");
    expect(run.conclusion?.root_cause).toBe("shutdown");
    expect(selectOrderedSteps(run)).toHaveLength(2);
  });
});

describe("troubleshoot store — answer/cancel/pause/resume invocations", () => {
  it("answerPrompt forwards arguments and clears pending prompt", async () => {
    useTroubleshootStore.getState().applyUserPromptEvent({
      run_id: "r1",
      step_id: "p1",
      prompt: "go?",
    });
    invokeMock.mockResolvedValue(undefined);
    await useTroubleshootStore.getState().answerPrompt("r1", "yes");
    expect(invokeMock).toHaveBeenCalledWith("answer_prompt", {
      runId: "r1",
      answer: "yes",
    });
    expect(useTroubleshootStore.getState().runs["r1"].pendingPrompt).toBeNull();
  });

  it("pauseRun/resumeRun/cancelRun forward to invoke with runId", async () => {
    invokeMock.mockResolvedValue(undefined);
    await useTroubleshootStore.getState().pauseRun("r1");
    await useTroubleshootStore.getState().resumeRun("r1");
    await useTroubleshootStore.getState().cancelRun("r1");
    const calls = invokeMock.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["pause_run", "resume_run", "cancel_run"]);
  });

  it("markRootCause forwards stepIdx and note", async () => {
    invokeMock.mockResolvedValue(undefined);
    await useTroubleshootStore.getState().markRootCause("r1", 3, "BGP shutdown");
    expect(invokeMock).toHaveBeenCalledWith("mark_root_cause", {
      runId: "r1",
      stepIdx: 3,
      note: "BGP shutdown",
    });
  });
});
