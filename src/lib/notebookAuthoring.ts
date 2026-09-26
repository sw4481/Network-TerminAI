//! Author-time helpers: build a `.mop.md` body from form-friendly drafts.
//! The Rust parser is the source of truth — emit_markdown produces input
//! it accepts, which we verify in tests by round-tripping through the
//! TypeScript-side YAML emitter.

import type {
  AssertionOp,
  AssertionSpec,
  ParameterSpec,
} from "./runnableNotebook";

export type DraftCell =
  | { kind: "markdown"; body: string }
  | { kind: "command"; body: string }
  | { kind: "approval"; body: string }
  | { kind: "assertion"; spec: AssertionSpec };

export interface NotebookDraft {
  title: string;
  description: string;
  vendor: string;
  platform: string;
  parameters: ParameterSpec[];
  cells: DraftCell[];
}

export const ASSERTION_OPS: AssertionOp[] = [
  "equals",
  "not_equals",
  "contains",
  "greater_than",
  "less_than",
  "exists",
];

const VENDORS = ["cisco", "juniper", "arista", "meraki", "generic"] as const;
export const VENDOR_OPTIONS = [...VENDORS];

export function blankDraft(): NotebookDraft {
  return {
    title: "",
    description: "",
    vendor: "cisco",
    platform: "iosxe",
    parameters: [],
    cells: [
      { kind: "markdown", body: "## Step 1\n\nDescribe what this step does." },
    ],
  };
}

export function emitFrontmatter(draft: NotebookDraft): string {
  const lines: string[] = ["---"];
  lines.push(`title: ${yamlScalar(draft.title || "Untitled")}`);
  if (draft.description) lines.push(`description: ${yamlScalar(draft.description)}`);
  if (draft.vendor) lines.push(`vendor: ${yamlScalar(draft.vendor)}`);
  if (draft.platform) lines.push(`platform: ${yamlScalar(draft.platform)}`);
  if (draft.parameters.length > 0) {
    lines.push("parameters:");
    for (const p of draft.parameters) {
      lines.push(`  - name: ${yamlScalar(p.name)}`);
      lines.push(`    prompt: ${yamlScalar(p.prompt || p.name)}`);
      if (p.default !== undefined && p.default !== "") {
        lines.push(`    default: ${yamlScalar(p.default)}`);
      }
    }
  }
  lines.push("---");
  return lines.join("\n");
}

export function emitBody(draft: NotebookDraft): string {
  const parts: string[] = [];
  for (const cell of draft.cells) {
    switch (cell.kind) {
      case "markdown":
        parts.push(cell.body.trim());
        break;
      case "command":
        parts.push(["```command", cell.body.trim(), "```"].join("\n"));
        break;
      case "approval":
        parts.push(["```approval", cell.body.trim(), "```"].join("\n"));
        break;
      case "assertion":
        parts.push(
          ["```assertion", JSON.stringify(cell.spec), "```"].join("\n"),
        );
        break;
    }
  }
  return parts.join("\n\n");
}

export function emitMarkdown(draft: NotebookDraft): string {
  return `${emitFrontmatter(draft)}\n\n${emitBody(draft)}\n`;
}

/**
 * Subset of YAML scalar emission. We only handle the cases the wizard
 * produces: bare strings, numbers-as-strings (parameter defaults), and
 * anything containing a colon, leading dash, or quote. We never emit
 * multi-line scalars — those come from the body, not frontmatter.
 */
export function yamlScalar(v: string): string {
  // Empty → ""
  if (v.length === 0) return '""';
  // Quote if it contains anything YAML-meaningful or starts with whitespace
  // / sigils. Single-quote: simpler escaping rules (only `'` → `''`).
  if (
    /^[\s\-?:&*!|>%@`#]/.test(v) ||
    /[:#"']/.test(v) ||
    /^(true|false|null|yes|no|on|off|~|)$/i.test(v) ||
    /^-?\d/.test(v)
  ) {
    return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  return v;
}

/**
 * Light validation. Returns an array of human-readable problems; an empty
 * array means the draft is good to import.
 */
export function validateDraft(draft: NotebookDraft): string[] {
  const errors: string[] = [];
  if (!draft.title.trim()) errors.push("Title is required.");

  const seen = new Set<string>();
  for (const p of draft.parameters) {
    if (!p.name.trim()) {
      errors.push("Parameter name cannot be empty.");
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.name)) {
      errors.push(
        `Parameter "${p.name}" must be a valid identifier (letters, digits, underscore; cannot start with a digit).`,
      );
    }
    if (seen.has(p.name)) errors.push(`Duplicate parameter name "${p.name}".`);
    seen.add(p.name);
  }

  draft.cells.forEach((cell, idx) => {
    if (cell.kind === "command" && !cell.body.trim()) {
      errors.push(`Cell ${idx + 1} (command) is empty.`);
    }
    if (cell.kind === "approval" && !cell.body.trim()) {
      errors.push(`Cell ${idx + 1} (approval) is empty.`);
    }
    if (cell.kind === "assertion") {
      if (!cell.spec.command.trim())
        errors.push(`Cell ${idx + 1} (assertion) is missing a command.`);
      if (!cell.spec.jsonpath.trim())
        errors.push(`Cell ${idx + 1} (assertion) is missing a JSONPath.`);
    }
  });

  return errors;
}

export function newCell(kind: DraftCell["kind"]): DraftCell {
  switch (kind) {
    case "markdown":
      return { kind, body: "" };
    case "command":
      return { kind, body: "" };
    case "approval":
      return { kind, body: "Review the configuration, then click Continue to apply." };
    case "assertion":
      return {
        kind,
        spec: {
          command: "",
          jsonpath: "$.",
          op: "equals",
          expected: "",
        },
      };
  }
}
