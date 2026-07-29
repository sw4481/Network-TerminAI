/**
 * Plan 15 Phase 4 — Zustand store for troubleshoot runs.
 *
 * Holds:
 *   * The catalogue of playbooks (refreshed on demand).
 *   * Per-run state keyed by `runId` — steps, narration entries, status,
 *     conclusion, and the most recent `awaiting_user` prompt.
 *   * `activeRunId` — what the page is currently watching.
 *
 * Event fan-in: the page component subscribes to the four `troubleshoot:*`
 * Tauri events and forwards each one through the matching `applyXEvent`
 * action. We keep dispatch logic out of the listener so the store is
 * unit-testable without spinning up a Tauri host.
 *
 * Two narration shapes are reconciled in `applyNarrationEvent` — the
 * Phase 3 dependency note in the plan file calls this out explicitly.
 */
import { create } from "zustand";
import {
  troubleshootApi,
  type ConclusionEvent,
  type NarrationEvent,
  type PlaybookMeta,
  type RunDetails,
  type RunStatus,
  type StatusEvent,
  type StepStatus,
  type StepUpdateEvent,
  type StoredStep,
  type UserPromptEvent,
  type Conclusion,
  type StartRunArgs,
} from "./api";

export interface NarrationEntry {
  /** Run id this narration belongs to. */
  runId: string;
  /** Step id (always present). */
  stepId: string;
  /** Optional 0-based step index — present in Phase 3 enriched payloads. */
  stepIdx?: number;
  /** Markdown body. May be empty when the LLM degraded gracefully. */
  text: string;
  /** RAG citation ids — empty array for legacy payloads. */
  citations: string[];
  /** Wall-clock ms when the entry was last updated. Used for sort ties. */
  updatedAt: number;
}

export interface PendingPrompt {
  stepId: string;
  prompt: string;
}

export interface RunState {
  runId: string;
  playbookId: string | null;
  tabId: string | null;
  symptom: string;
  status: RunStatus;
  /** Indexed by `idx` (0-based). Sparse during early frames. */
  steps: Record<number, StoredStep>;
  /** Insertion-ordered narration. Keyed by `stepId` for de-dupe. */
  narration: Record<string, NarrationEntry>;
  pendingPrompt: PendingPrompt | null;
  conclusion: Conclusion | null;
  cancelReason: string | null;
}

interface TroubleshootStore {
  playbooks: PlaybookMeta[];
  loadingPlaybooks: boolean;
  playbooksError: string | null;

  runs: Record<string, RunState>;
  activeRunId: string | null;

  refreshPlaybooks: () => Promise<void>;
  hydrateRun: (runId: string) => Promise<void>;
  setActiveRun: (runId: string | null) => void;

  startRun: (args: StartRunArgs) => Promise<string>;
  pauseRun: (runId: string) => Promise<void>;
  resumeRun: (runId: string) => Promise<void>;
  cancelRun: (runId: string) => Promise<void>;
  answerPrompt: (runId: string, answer: string) => Promise<void>;
  markRootCause: (
    runId: string,
    stepIdx: number,
    note: string,
  ) => Promise<void>;

  applyStepEvent: (ev: StepUpdateEvent) => void;
  applyStatusEvent: (ev: StatusEvent) => void;
  applyNarrationEvent: (ev: NarrationEvent) => void;
  applyConclusionEvent: (ev: ConclusionEvent) => void;
  applyUserPromptEvent: (ev: UserPromptEvent) => void;

  /** Reset the store — used by tests. */
  reset: () => void;
}

const EMPTY_RUN = (runId: string): RunState => ({
  runId,
  playbookId: null,
  tabId: null,
  symptom: "",
  status: "running",
  steps: {},
  narration: {},
  pendingPrompt: null,
  conclusion: null,
  cancelReason: null,
});

function ensureRun(runs: Record<string, RunState>, runId: string): RunState {
  return runs[runId] ?? EMPTY_RUN(runId);
}

function isAwaitingUser(steps: Record<number, StoredStep>): StoredStep | null {
  let chosen: StoredStep | null = null;
  for (const s of Object.values(steps)) {
    if (s.status === "awaiting_user") {
      if (!chosen || s.idx > chosen.idx) chosen = s;
    }
  }
  return chosen;
}

export const useTroubleshootStore = create<TroubleshootStore>((set) => ({
  playbooks: [],
  loadingPlaybooks: false,
  playbooksError: null,
  runs: {},
  activeRunId: null,

  refreshPlaybooks: async () => {
    set({ loadingPlaybooks: true, playbooksError: null });
    try {
      const playbooks = await troubleshootApi.listPlaybooks();
      set({ playbooks, loadingPlaybooks: false });
    } catch (e) {
      set({ playbooksError: String(e), loadingPlaybooks: false });
    }
  },

  hydrateRun: async (runId) => {
    try {
      const details: RunDetails = await troubleshootApi.getRun(runId);
      set((state) => {
        const stepsByIdx: Record<number, StoredStep> = {};
        for (const s of details.steps) stepsByIdx[s.idx] = s;
        const conclusion =
          details.conclusion_json &&
          typeof details.conclusion_json === "object" &&
          "root_cause" in details.conclusion_json
            ? (details.conclusion_json as Conclusion)
            : null;
        const next: RunState = {
          ...ensureRun(state.runs, runId),
          runId,
          playbookId: details.playbook_id,
          tabId: details.tab_id,
          symptom: details.symptom,
          status: details.status,
          steps: stepsByIdx,
          conclusion,
        };
        const awaiting = isAwaitingUser(stepsByIdx);
        next.pendingPrompt = awaiting
          ? { stepId: awaiting.step_ref, prompt: extractPrompt(awaiting) }
          : null;
        return { runs: { ...state.runs, [runId]: next } };
      });
    } catch (e) {
      console.warn("[troubleshoot] hydrateRun failed", e);
    }
  },

  setActiveRun: (runId) => set({ activeRunId: runId }),

  startRun: async (args) => {
    const runId = await troubleshootApi.startRun(args);
    set((state) => {
      const seed: RunState = {
        ...EMPTY_RUN(runId),
        playbookId: args.playbookId,
        tabId: args.tabId,
        symptom: args.symptom,
        status: "running",
      };
      return {
        runs: { ...state.runs, [runId]: seed },
        activeRunId: runId,
      };
    });
    return runId;
  },

  pauseRun: async (runId) => {
    await troubleshootApi.pauseRun(runId);
  },
  resumeRun: async (runId) => {
    await troubleshootApi.resumeRun(runId);
  },
  cancelRun: async (runId) => {
    await troubleshootApi.cancelRun(runId);
  },
  answerPrompt: async (runId, answer) => {
    await troubleshootApi.answerPrompt(runId, answer);
    set((state) => {
      const run = state.runs[runId];
      if (!run) return state;
      return {
        runs: { ...state.runs, [runId]: { ...run, pendingPrompt: null } },
      };
    });
  },
  markRootCause: async (runId, stepIdx, note) => {
    await troubleshootApi.markRootCause(runId, stepIdx, note);
  },

  applyStepEvent: (ev) =>
    set((state) => {
      const run = ensureRun(state.runs, ev.run_id);
      const stored: StoredStep = {
        idx: ev.step.idx,
        step_type: ev.step_type,
        step_ref: ev.step.step_id,
        status: ev.step.status as StepStatus,
        result_json: ev.step.result_json,
      };
      const nextSteps = { ...run.steps, [stored.idx]: stored };
      const awaiting = isAwaitingUser(nextSteps);
      const pendingPrompt = awaiting
        ? { stepId: awaiting.step_ref, prompt: extractPrompt(awaiting) }
        : run.pendingPrompt &&
            !nextSteps[
              Object.values(nextSteps).find(
                (s) => s.step_ref === run.pendingPrompt!.stepId,
              )?.idx ?? -1
            ]
          ? null
          : run.pendingPrompt && awaiting === null
            ? null
            : run.pendingPrompt;
      return {
        runs: {
          ...state.runs,
          [ev.run_id]: { ...run, steps: nextSteps, pendingPrompt },
        },
      };
    }),

  applyStatusEvent: (ev) =>
    set((state) => {
      const run = ensureRun(state.runs, ev.run_id);
      const next: RunState = {
        ...run,
        status: ev.status,
        cancelReason: ev.reason ?? run.cancelReason,
      };
      // On terminal status the awaiting prompt is meaningless — clear it.
      if (ev.status === "completed" || ev.status === "failed") {
        next.pendingPrompt = null;
      }
      return { runs: { ...state.runs, [ev.run_id]: next } };
    }),

  applyNarrationEvent: (ev) =>
    set((state) => {
      const run = ensureRun(state.runs, ev.run_id);
      const existing = run.narration[ev.step_id];
      // Phase 3 reconciliation: prefer the richer shape's metadata, but
      // always take the most recent `text`. Citations merge as a set.
      const mergedCitations = new Set<string>();
      for (const c of existing?.citations ?? []) mergedCitations.add(c);
      for (const c of ev.citations ?? []) mergedCitations.add(c);
      const merged: NarrationEntry = {
        runId: ev.run_id,
        stepId: ev.step_id,
        stepIdx:
          ev.step_idx !== undefined
            ? ev.step_idx
            : existing?.stepIdx,
        text: ev.text ?? existing?.text ?? "",
        citations: Array.from(mergedCitations),
        updatedAt: Date.now(),
      };
      return {
        runs: {
          ...state.runs,
          [ev.run_id]: {
            ...run,
            narration: { ...run.narration, [ev.step_id]: merged },
          },
        },
      };
    }),

  applyConclusionEvent: (ev) =>
    set((state) => {
      const run = ensureRun(state.runs, ev.run_id);
      return {
        runs: {
          ...state.runs,
          [ev.run_id]: { ...run, conclusion: ev.conclusion },
        },
      };
    }),

  applyUserPromptEvent: (ev) =>
    set((state) => {
      const run = ensureRun(state.runs, ev.run_id);
      return {
        runs: {
          ...state.runs,
          [ev.run_id]: {
            ...run,
            pendingPrompt: { stepId: ev.step_id, prompt: ev.prompt },
          },
        },
      };
    }),

  reset: () =>
    set({
      playbooks: [],
      loadingPlaybooks: false,
      playbooksError: null,
      runs: {},
      activeRunId: null,
    }),
}));

/** Heuristic prompt extraction from a stored step's result_json. */
function extractPrompt(step: StoredStep): string {
  const r = step.result_json;
  if (r && typeof r === "object" && "prompt" in r) {
    const v = (r as { prompt: unknown }).prompt;
    if (typeof v === "string") return v;
  }
  return `Operator input required for step ${step.step_ref}`;
}

/** Selector: the active run, or null. */
export function selectActiveRun(state: {
  runs: Record<string, RunState>;
  activeRunId: string | null;
}): RunState | null {
  if (!state.activeRunId) return null;
  return state.runs[state.activeRunId] ?? null;
}

/** Selector: ordered narration entries for a run, oldest→newest by stepIdx. */
export function selectOrderedNarration(run: RunState | null): NarrationEntry[] {
  if (!run) return [];
  return Object.values(run.narration).sort((a, b) => {
    const ai = a.stepIdx ?? Number.MAX_SAFE_INTEGER;
    const bi = b.stepIdx ?? Number.MAX_SAFE_INTEGER;
    if (ai !== bi) return ai - bi;
    return a.updatedAt - b.updatedAt;
  });
}

/** Selector: ordered steps for a run, by idx ascending. */
export function selectOrderedSteps(run: RunState | null): StoredStep[] {
  if (!run) return [];
  return Object.values(run.steps).sort((a, b) => a.idx - b.idx);
}
