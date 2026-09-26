/**
 * Plan 15 Phase 4 — typed wrappers around the troubleshoot Tauri commands.
 *
 * Mirrors the pattern used by `lib/topology.ts` and `lib/recording.ts`:
 * thin pass-through with TS types kept in sync with Rust serde shapes.
 * Business logic (subscribing to events, mutating store state) lives in
 * `store.ts`; this module is intentionally side-effect free except for
 * the `invoke` calls themselves.
 *
 * Phase 3's `produce_conclusion` returns the four guaranteed fields
 * (`root_cause`, `confidence`, `suggested_fix`, `evidence[]`); we type
 * those here so the store and UI never have to deal with `unknown`.
 */
import { invoke } from "@tauri-apps/api/core";

export type RunStatus = "running" | "paused" | "completed" | "failed";

export type StepStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "skipped"
  | "awaiting_user";

export type StepType =
  | "command"
  | "assertion"
  | "branch"
  | "narration"
  | "user_prompt"
  | "unknown";

export type Confidence = "low" | "medium" | "high";

export interface PlaybookMeta {
  id: string;
  name: string;
  vendor: string;
  platform: string;
  symptom_keywords: string[];
  builtin: boolean;
  created_at: number;
  updated_at: number;
}

export interface StoredStep {
  idx: number;
  step_type: StepType;
  step_ref: string;
  status: StepStatus;
  result_json?: unknown;
  parent_idx?: number;
  started_at?: number;
  ended_at?: number;
}

export interface Conclusion {
  root_cause: string;
  confidence: Confidence;
  suggested_fix: string;
  evidence: string[];
}

export interface RunDetails {
  run_id: string;
  playbook_id: string;
  tab_id: string;
  symptom: string;
  status: RunStatus;
  started_at: number;
  ended_at?: number;
  conclusion_json?: Conclusion | Record<string, unknown>;
  steps: StoredStep[];
}

export interface StartRunArgs {
  playbookId: string;
  tabId: string;
  symptom: string;
  vars: Record<string, unknown>;
  /**
   * SSH-direct execution (Plan 15 over interactive SSH): a saved connection id
   * (and optional prompted password) runs the playbook's commands over
   * one-shot SSH. Omit to keep the no-transport-wired stub behaviour.
   */
  connectionId?: string;
  password?: string;
}

/**
 * Plan 15 Phase 5 — single result from `match_symptom`.
 *
 * `score` is roughly in [0, 1] (the sidecar blends BM25-norm and
 * embedding cosine). The UI enforces the 0.35 threshold for a "good
 * match"; anything below routes to the no-match fallback. `reasons`
 * is human-readable text (e.g. "keyword 'bgp' matched") rendered as
 * chips next to each suggestion.
 */
export interface MatchResult {
  id: string;
  score: number;
  reasons: string[];
}

/** UI threshold below which we treat the matcher as having no good
 * match. Kept here so tests + components share a single source of
 * truth. */
export const MATCH_THRESHOLD = 0.35;

export const troubleshootApi = {
  listPlaybooks: () => invoke<PlaybookMeta[]>("list_playbooks"),
  getPlaybook: (id: string) => invoke<string>("get_playbook", { id }),
  upsertPlaybook: (id: string, bodyYaml: string) =>
    invoke<void>("upsert_playbook", { id, bodyYaml }),
  deletePlaybook: (id: string) => invoke<void>("delete_playbook", { id }),

  startRun: (args: StartRunArgs) =>
    invoke<string>("start_run", {
      playbookId: args.playbookId,
      tabId: args.tabId,
      symptom: args.symptom,
      vars: args.vars,
      connectionId: args.connectionId,
      password: args.password,
    }),
  pauseRun: (runId: string) => invoke<void>("pause_run", { runId }),
  resumeRun: (runId: string, connectionId?: string, password?: string) =>
    invoke<void>("resume_run", { runId, connectionId, password }),
  cancelRun: (runId: string) => invoke<void>("cancel_run", { runId }),
  answerPrompt: (runId: string, answer: string) =>
    invoke<void>("answer_prompt", { runId, answer }),
  markRootCause: (runId: string, stepIdx: number, note: string) =>
    invoke<void>("mark_root_cause", { runId, stepIdx, note }),
  getRun: (runId: string) => invoke<RunDetails>("get_run", { runId }),

  /**
   * Plan 15 Phase 5 — rank the playbook catalogue against a symptom.
   *
   * Returns up to five candidates sorted by score descending. Empty
   * symptom or empty catalogue short-circuits to `[]`. The UI is
   * expected to debounce this call (300ms) so we don't fire one
   * matcher request per keystroke.
   */
  matchSymptom: (
    symptom: string,
    vendor?: string | null,
    platform?: string | null,
  ) =>
    invoke<MatchResult[]>("match_symptom", {
      symptom,
      vendor: vendor ?? null,
      platform: platform ?? null,
    }),

  /**
   * Playbook editor "Generate with AI" — author a schema-valid playbook
   * YAML from a free-form symptom using the Settings-page LLM. Returns
   * the YAML plus an optional soft warning (e.g. schema violation) that
   * the editor can surface without discarding the generated text.
   */
  generatePlaybook: (
    symptom: string,
    vendor?: string | null,
    platform?: string | null,
  ) =>
    invoke<GeneratedPlaybook>("generate_playbook", {
      symptom,
      vendor: vendor ?? null,
      platform: platform ?? null,
    }),
};

export interface GeneratedPlaybook {
  yaml: string;
  error: string | null;
}

/**
 * Event payload shapes — keep these in sync with the Rust `app.emit(...)`
 * call sites in `src-tauri/src/commands/troubleshoot.rs` and
 * `src-tauri/src/troubleshoot/live_executor.rs`.
 */

export interface StepUpdateEvent {
  run_id: string;
  step: {
    step_id: string;
    idx: number;
    status: StepStatus;
    result_json: unknown;
    next_step_id?: string | null;
  };
  step_type: StepType;
}

export interface StatusEvent {
  run_id: string;
  status: RunStatus;
  reason?: string;
}

/**
 * Phase 3 leaves two narration shapes on main:
 *
 *  * Phase 2 legacy — `{run_id, step_id, text}`.
 *  * Phase 3 enriched — `{run_id, step_idx, step_id, text, citations[]}`.
 *
 * The store reconciles both by treating every field except `run_id` and
 * `step_id` as optional. When both arrive for the same `step_id`, the
 * richer shape wins (citations + step_idx), but the text is whichever
 * arrived last.
 */
export interface NarrationEvent {
  run_id: string;
  step_id: string;
  step_idx?: number;
  text?: string;
  citations?: string[];
}

export interface ConclusionEvent {
  run_id: string;
  conclusion: Conclusion;
}

export interface UserPromptEvent {
  run_id: string;
  step_id: string;
  prompt: string;
}
