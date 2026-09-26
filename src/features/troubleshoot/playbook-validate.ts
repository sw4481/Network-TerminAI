/**
 * Plan 15 Phase 6 — Pure-JS validator for the playbook YAML buffer.
 *
 * monaco-yaml does inline schema validation in the editor, but the
 * Save button needs a final verdict so we run a parallel pure-JS pass
 * here. This module is jsdom-friendly (no Monaco dependency) and the
 * unit tests target it directly.
 *
 * Three layers of validation are stacked:
 *
 *   1. YAML parses — `js-yaml` raises on malformed YAML; we surface
 *      the line/col when present.
 *   2. Schema check — a tiny hand-rolled walker against the shapes
 *      defined in `playbook-schema.json`. We don't pull in Ajv to keep
 *      the bundle slim (it's already 60kb gzipped and we use exactly
 *      one schema).
 *   3. Cross-reference check — every `next`, `on_pass`, `on_fail`, and
 *      `cases[].next` must point to a real step id. Schema can't
 *      enforce this; we walk the parsed AST.
 *
 * Returns a list of `Diagnostic`s, empty when the buffer is valid.
 * The Diagnostic shape is what the UI's diagnostics panel renders.
 */
import yaml from "js-yaml";
import type { StoredStep, StepType } from "./api";

export type DiagnosticSeverity = "error" | "warn";

export interface Diagnostic {
  severity: DiagnosticSeverity;
  message: string;
  /** 1-based line if known. */
  line?: number;
  /** 1-based column if known. */
  column?: number;
  /** Logical path within the document, e.g. `steps[2].command`. */
  path?: string;
}

const STEP_TYPES = new Set<StepType>([
  "command",
  "assertion",
  "branch",
  "narration",
  "user_prompt",
]);

/**
 * Lint an `assertion`/`branch` expression for JSONPath syntax that the
 * Rust engine — which evaluates expressions with the `jmespath` crate —
 * cannot compile. An invalid expression makes the engine hard-fail the
 * whole run at that step (this is exactly what silently broke the
 * `cisco-iosxe-8021x-auth-failure` playbook: `$.interfaces[?(@.x>0)]`
 * and `$.session_state` are JSONPath, so the run died right after
 * step 0). We flag the unambiguous JSONPath markers that are never
 * valid JMESPath. Returns an error message, or null when the
 * expression has no JSONPath tells.
 */
export function lintExpressionSyntax(expr: string): string | null {
  // Leading `$` (JSONPath root). JMESPath addresses fields directly:
  // `session_state`, not `$.session_state`.
  if (/(^|[^a-zA-Z0-9_])\$/.test(expr)) {
    return "Expression looks like JSONPath ('$'), but the engine uses JMESPath. Drop the leading '$.' — e.g. 'session_state' instead of '$.session_state'.";
  }
  // JSONPath filter with parentheses: `[?(@.x > 0)]`. JMESPath filters
  // have no parens and no `@.` — e.g. `interfaces[?auth_failures > `0`]`.
  if (/\[\s*\?\s*\(/.test(expr)) {
    return "Expression uses JSONPath filter syntax '[?(...)]', but the engine uses JMESPath. Write filters as e.g. 'interfaces[?auth_failures > `0`]' (no parentheses, no '@.').";
  }
  // JSONPath recursive descent `..`.
  if (/\.\./.test(expr)) {
    return "Expression uses JSONPath recursive descent '..', which is not valid JMESPath. Address the field by its explicit path.";
  }
  // Bare `@.` outside a filter (JSONPath current-node member access).
  if (/@\./.test(expr)) {
    return "Expression uses JSONPath current-node access '@.', which is not valid JMESPath. Reference the field name directly.";
  }
  return null;
}

/** Top-level parse + schema + xref pass. */
export function validatePlaybookYaml(text: string): {
  doc: unknown;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  let doc: unknown = null;

  if (!text.trim()) {
    diagnostics.push({
      severity: "error",
      message: "Playbook is empty.",
    });
    return { doc: null, diagnostics };
  }

  try {
    doc = yaml.load(text);
  } catch (e) {
    const ye = e as yaml.YAMLException;
    diagnostics.push({
      severity: "error",
      message: ye.reason ?? ye.message ?? String(e),
      line: ye.mark?.line != null ? ye.mark.line + 1 : undefined,
      column: ye.mark?.column != null ? ye.mark.column + 1 : undefined,
    });
    return { doc: null, diagnostics };
  }

  if (doc == null || typeof doc !== "object" || Array.isArray(doc)) {
    diagnostics.push({
      severity: "error",
      message: "Top-level YAML must be a mapping (object).",
    });
    return { doc: null, diagnostics };
  }

  // Schema walk.
  const obj = doc as Record<string, unknown>;
  validateRoot(obj, diagnostics);

  // Cross-reference walk (only meaningful if steps[] is at least
  // structurally well-formed).
  if (Array.isArray(obj.steps)) {
    validateCrossReferences(obj.steps as Array<Record<string, unknown>>, diagnostics);
  }

  return { doc, diagnostics };
}

function validateRoot(obj: Record<string, unknown>, out: Diagnostic[]) {
  const required = ["id", "name", "symptom_keywords", "vendor", "platform", "steps"];
  for (const k of required) {
    if (!(k in obj)) {
      out.push({
        severity: "error",
        message: `Missing required field: ${k}`,
        path: k,
      });
    }
  }

  if (typeof obj.id === "string") {
    if (!/^[a-z0-9-]+$/.test(obj.id) || obj.id.length === 0) {
      out.push({
        severity: "error",
        message: "id must be lowercase letters, digits, or dashes only.",
        path: "id",
      });
    }
  } else if ("id" in obj) {
    out.push({ severity: "error", message: "id must be a string.", path: "id" });
  }

  if ("name" in obj && (typeof obj.name !== "string" || !obj.name)) {
    out.push({ severity: "error", message: "name must be a non-empty string.", path: "name" });
  }

  if ("vendor" in obj && (typeof obj.vendor !== "string" || !obj.vendor)) {
    out.push({ severity: "error", message: "vendor must be a non-empty string.", path: "vendor" });
  }

  if ("platform" in obj && (typeof obj.platform !== "string" || !obj.platform)) {
    out.push({ severity: "error", message: "platform must be a non-empty string.", path: "platform" });
  }

  if ("symptom_keywords" in obj) {
    if (!Array.isArray(obj.symptom_keywords) || obj.symptom_keywords.length === 0) {
      out.push({
        severity: "error",
        message: "symptom_keywords must be a non-empty array of strings.",
        path: "symptom_keywords",
      });
    } else {
      for (let i = 0; i < obj.symptom_keywords.length; i++) {
        const kw = obj.symptom_keywords[i];
        if (typeof kw !== "string" || !kw) {
          out.push({
            severity: "error",
            message: "symptom_keywords entries must be non-empty strings.",
            path: `symptom_keywords[${i}]`,
          });
        }
      }
    }
  }

  if ("description" in obj && obj.description != null && typeof obj.description !== "string") {
    out.push({ severity: "error", message: "description must be a string.", path: "description" });
  }

  if ("steps" in obj) {
    if (!Array.isArray(obj.steps) || obj.steps.length === 0) {
      out.push({
        severity: "error",
        message: "steps must be a non-empty array.",
        path: "steps",
      });
    } else {
      for (let i = 0; i < obj.steps.length; i++) {
        validateStep(obj.steps[i] as Record<string, unknown>, i, out);
      }
    }
  }
}

function validateStep(step: Record<string, unknown>, idx: number, out: Diagnostic[]) {
  const where = `steps[${idx}]`;
  if (typeof step !== "object" || step == null || Array.isArray(step)) {
    out.push({ severity: "error", message: "step must be a mapping.", path: where });
    return;
  }
  if (typeof step.id !== "string" || !step.id) {
    out.push({ severity: "error", message: "step.id is required and must be a non-empty string.", path: `${where}.id` });
  }
  if (typeof step.type !== "string" || !STEP_TYPES.has(step.type as StepType)) {
    out.push({
      severity: "error",
      message: `step.type must be one of ${Array.from(STEP_TYPES).join(", ")}`,
      path: `${where}.type`,
    });
    return;
  }

  const t = step.type as StepType;
  if (t === "command") {
    if (typeof step.command !== "string" || !step.command) {
      out.push({ severity: "error", message: "command step requires a non-empty 'command'.", path: `${where}.command` });
    }
  } else if (t === "assertion") {
    if (typeof step.expression !== "string" || !step.expression) {
      out.push({ severity: "error", message: "assertion step requires a 'expression' (JMESPath).", path: `${where}.expression` });
    } else {
      const lint = lintExpressionSyntax(step.expression);
      if (lint) out.push({ severity: "error", message: lint, path: `${where}.expression` });
    }
    if (!("expects" in step)) {
      out.push({ severity: "error", message: "assertion step requires an 'expects' value.", path: `${where}.expects` });
    }
    if ("on_pass" in step && (typeof step.on_pass !== "string" || !step.on_pass)) {
      out.push({ severity: "error", message: "on_pass must be a non-empty step id string.", path: `${where}.on_pass` });
    }
    if ("on_fail" in step && (typeof step.on_fail !== "string" || !step.on_fail)) {
      out.push({ severity: "error", message: "on_fail must be a non-empty step id string.", path: `${where}.on_fail` });
    }
  } else if (t === "branch") {
    if (typeof step.expression === "string" && step.expression) {
      const lint = lintExpressionSyntax(step.expression);
      if (lint) out.push({ severity: "error", message: lint, path: `${where}.expression` });
    }
    if (!Array.isArray(step.cases) || step.cases.length === 0) {
      out.push({ severity: "error", message: "branch step requires a non-empty 'cases' array.", path: `${where}.cases` });
    } else {
      for (let j = 0; j < step.cases.length; j++) {
        const c = step.cases[j] as Record<string, unknown>;
        if (typeof c !== "object" || c == null) {
          out.push({ severity: "error", message: "case must be a mapping.", path: `${where}.cases[${j}]` });
          continue;
        }
        if (!("when" in c)) {
          out.push({ severity: "error", message: "case requires 'when'.", path: `${where}.cases[${j}].when` });
        } else {
          const w = c.when;
          if (
            w !== null &&
            typeof w !== "string" &&
            typeof w !== "number" &&
            typeof w !== "boolean"
          ) {
            out.push({
              severity: "error",
              message: "case.when must be a string, boolean, number, or null.",
              path: `${where}.cases[${j}].when`,
            });
          }
        }
        if (typeof c.next !== "string" || !c.next) {
          out.push({
            severity: "error",
            message: "case.next must be a non-empty step id string.",
            path: `${where}.cases[${j}].next`,
          });
        }
      }
    }
  } else if (t === "narration") {
    if (typeof step.text !== "string" || !step.text) {
      out.push({ severity: "error", message: "narration step requires non-empty 'text'.", path: `${where}.text` });
    }
  } else if (t === "user_prompt") {
    if (typeof step.prompt !== "string" || !step.prompt) {
      out.push({ severity: "error", message: "user_prompt step requires non-empty 'prompt'.", path: `${where}.prompt` });
    }
  }
}

function validateCrossReferences(
  steps: Array<Record<string, unknown>>,
  out: Diagnostic[],
) {
  const ids = new Set<string>();
  for (const s of steps) {
    if (typeof s?.id === "string" && s.id) {
      if (ids.has(s.id)) {
        out.push({
          severity: "error",
          message: `Duplicate step id: ${s.id}`,
          path: `steps[].id`,
        });
      }
      ids.add(s.id);
    }
  }

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const where = `steps[${i}]`;
    if (typeof s.on_pass === "string" && s.on_pass && !ids.has(s.on_pass)) {
      out.push({
        severity: "error",
        message: `on_pass references unknown step id: ${s.on_pass}`,
        path: `${where}.on_pass`,
      });
    }
    if (typeof s.on_fail === "string" && s.on_fail && !ids.has(s.on_fail)) {
      out.push({
        severity: "error",
        message: `on_fail references unknown step id: ${s.on_fail}`,
        path: `${where}.on_fail`,
      });
    }
    if (Array.isArray(s.cases)) {
      for (let j = 0; j < s.cases.length; j++) {
        const c = s.cases[j] as Record<string, unknown>;
        if (typeof c?.next === "string" && c.next && !ids.has(c.next)) {
          out.push({
            severity: "error",
            message: `case[${j}].next references unknown step id: ${c.next}`,
            path: `${where}.cases[${j}].next`,
          });
        }
      }
    }
  }
}

/**
 * Convert a parsed playbook doc into an array of `StoredStep`s with
 * status="pending" so the existing `<TreeCanvas>` can render a live
 * preview. The preview is best-effort — if the doc is malformed we
 * return whatever steps were parseable.
 */
export function previewStepsFromDoc(doc: unknown): StoredStep[] {
  if (!doc || typeof doc !== "object") return [];
  const obj = doc as Record<string, unknown>;
  if (!Array.isArray(obj.steps)) return [];
  const out: StoredStep[] = [];
  for (let i = 0; i < obj.steps.length; i++) {
    const s = obj.steps[i] as Record<string, unknown>;
    const stepRef = typeof s?.id === "string" ? s.id : `step-${i}`;
    const stepType = typeof s?.type === "string" && STEP_TYPES.has(s.type as StepType)
      ? (s.type as StepType)
      : "unknown";
    out.push({
      idx: i,
      step_type: stepType,
      step_ref: stepRef,
      status: "pending",
    });
  }
  return out;
}

/** A minimal blank playbook YAML string used by the "New" button. */
export const BLANK_PLAYBOOK_YAML = `id: my-new-playbook
name: My new playbook
description: Describe the failure mode this playbook diagnoses.
vendor: cisco
platform: iosxe
symptom_keywords:
  - replace
  - with
  - your
  - keywords
steps:
  - id: step-1
    type: command
    command: show version
  - id: step-2
    type: narration
    text: One or two sentence explanation of what we just looked at.
`;

/** Suggest a fresh slug derived from `base` that's not already taken. */
export function suggestUniqueId(base: string, existing: Iterable<string>): string {
  const taken = new Set<string>(existing);
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const safe = slug || "playbook";
  if (!taken.has(safe)) return safe;
  let n = 2;
  while (taken.has(`${safe}-${n}`)) n++;
  return `${safe}-${n}`;
}
