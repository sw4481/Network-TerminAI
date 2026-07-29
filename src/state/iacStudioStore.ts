import { create } from "zustand";
import type { LintDiagnostic, LinterStatus } from "../lib/tauri";
import type { ResolvedCoachStep } from "../components/editor/coachMarkAnchors";

export type PendingWizard = "resource" | "pipeline" | "onboarding" | null;

/** Active on-editor coach-mark walkthrough (pipeline onboarding). */
export interface CoachSlice {
  active: boolean;
  steps: ResolvedCoachStep[];
  index: number;
}

export interface AiProposal {
  code: string;
  filename: string;
  explanation: string;
  /** When set, accepting writes a NEW file at this path instead of editing the
   * active buffer. Absent for the Phase C buffer-edit path. */
  target_path?: string;
  validation: { valid: boolean | null; skipped: boolean; error: string | null };
}

export interface AiSlice {
  generating: boolean;
  proposal: AiProposal | null;
  error: string | null;
}

export interface IacStudioTabState {
  root_path: string | null;
  file_path: string | null;
  content: string;
  language: string;
  is_dirty: boolean;
  expanded_dirs: Set<string>;
  cursor: { line: number; column: number };
  loading: boolean;
  error: string | null;
  diagnostics: LintDiagnostic[];
  linters: LinterStatus[];
  ai: AiSlice;
  pending_wizard: PendingWizard;
  /** On-editor pipeline coach-marks; null when not walking through. */
  coach: CoachSlice | null;
  /** Set by the onboarding wizard on generate; consumed once the pipeline file
   *  opens, to auto-start coach-marks against the just-written YAML. */
  coach_pending: boolean;
}

interface IacStudioStore {
  tabs: Record<string, IacStudioTabState>;
  ensure: (tabId: string, rootPath: string) => IacStudioTabState;
  patch: (tabId: string, p: Partial<IacStudioTabState>) => void;
  openFile: (tabId: string, filePath: string, content: string, language: string) => void;
  setContent: (tabId: string, content: string) => void;
  setDirty: (tabId: string, dirty: boolean) => void;
  setCursor: (tabId: string, line: number, column: number) => void;
  toggleDir: (tabId: string, dirPath: string) => void;
  setRoot: (tabId: string, rootPath: string) => void;
  setDiagnostics: (tabId: string, result: { diagnostics: LintDiagnostic[]; linters: LinterStatus[] }) => void;
  setAiGenerating: (tabId: string, generating: boolean) => void;
  setAiProposal: (tabId: string, proposal: AiProposal) => void;
  clearAiProposal: (tabId: string) => void;
  setAiError: (tabId: string, error: string) => void;
  setPendingWizard: (tabId: string, w: PendingWizard) => void;
  setCoachPending: (tabId: string, pending: boolean) => void;
  startCoach: (tabId: string, steps: ResolvedCoachStep[]) => void;
  coachNext: (tabId: string) => void;
  coachBack: (tabId: string) => void;
  coachEnd: (tabId: string) => void;
}

/**
 * Build a fresh, unseeded tab state. Exported so components can use it as a
 * pure render-time fallback before the store has been seeded (the seeding
 * happens in a useEffect, which runs after the first render) — WITHOUT
 * mutating the store during render.
 */
export function freshIacStudioState(rootPath: string): IacStudioTabState {
  return {
    root_path: rootPath,
    file_path: null,
    content: "",
    language: "plaintext",
    is_dirty: false,
    expanded_dirs: new Set<string>([rootPath]),
    cursor: { line: 1, column: 1 },
    loading: false,
    error: null,
    diagnostics: [],
    linters: [],
    ai: { generating: false, proposal: null, error: null },
    pending_wizard: null,
    coach: null,
    coach_pending: false,
  };
}

export const useIacStudioStore = create<IacStudioStore>((set, get) => ({
  tabs: {},

  ensure: (tabId, rootPath) => {
    const existing = get().tabs[tabId];
    if (existing) return existing;
    const seeded = freshIacStudioState(rootPath);
    set((s) => ({ tabs: { ...s.tabs, [tabId]: seeded } }));
    return seeded;
  },

  patch: (tabId, p) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, ...p } } };
    }),

  openFile: (tabId, filePath, content, language) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, file_path: filePath, content, language, is_dirty: false, error: null },
        },
      };
    }),

  setContent: (tabId, content) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, content, is_dirty: true } } };
    }),

  setDirty: (tabId, dirty) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, is_dirty: dirty } } };
    }),

  setCursor: (tabId, line, column) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, cursor: { line, column } } } };
    }),

  toggleDir: (tabId, dirPath) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      const next = new Set(cur.expanded_dirs);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return { tabs: { ...s.tabs, [tabId]: { ...cur, expanded_dirs: next } } };
    }),

  setRoot: (tabId, rootPath) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, root_path: rootPath, expanded_dirs: new Set<string>([rootPath]) },
        },
      };
    }),

  setDiagnostics: (tabId, result) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, diagnostics: result.diagnostics, linters: result.linters },
        },
      };
    }),

  setAiGenerating: (tabId, generating) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, ai: { ...cur.ai, generating, error: generating ? null : cur.ai.error } },
        },
      };
    }),

  setAiProposal: (tabId, proposal) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, ai: { generating: false, proposal, error: null } },
        },
      };
    }),

  clearAiProposal: (tabId) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: { ...s.tabs, [tabId]: { ...cur, ai: { ...cur.ai, proposal: null } } },
      };
    }),

  setAiError: (tabId, error) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return {
        tabs: {
          ...s.tabs,
          [tabId]: { ...cur, ai: { ...cur.ai, generating: false, error } },
        },
      };
    }),

  setPendingWizard: (tabId, w) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, pending_wizard: w } } };
    }),

  setCoachPending: (tabId, pending) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, coach_pending: pending } } };
    }),

  startCoach: (tabId, steps) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      // No anchors → nothing to teach; leave coach off so no empty overlay shows.
      const coach = steps.length > 0 ? { active: true, steps, index: 0 } : null;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, coach, coach_pending: false } } };
    }),

  coachNext: (tabId) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur || !cur.coach) return s;
      const next = cur.coach.index + 1;
      // Past the last step ends the walkthrough.
      const coach = next >= cur.coach.steps.length ? null : { ...cur.coach, index: next };
      return { tabs: { ...s.tabs, [tabId]: { ...cur, coach } } };
    }),

  coachBack: (tabId) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur || !cur.coach) return s;
      const prev = Math.max(0, cur.coach.index - 1);
      return { tabs: { ...s.tabs, [tabId]: { ...cur, coach: { ...cur.coach, index: prev } } } };
    }),

  coachEnd: (tabId) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, coach: null } } };
    }),
}));
