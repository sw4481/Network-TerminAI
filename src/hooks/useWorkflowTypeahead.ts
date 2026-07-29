import { useMemo } from "react";

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export interface UseWorkflowTypeaheadArgs {
  template: string;
  values: Record<string, string>;
}

export interface UseWorkflowTypeaheadResult {
  rendered: string;
  caret: number;
  unfilled: string[];
}

/**
 * Renders a workflow template against the partial values map. Unfilled
 * placeholders are kept as `{{name}}` so the user can see what's still
 * missing; the caret is positioned right after the last filled placeholder
 * (or end of string if everything is filled).
 */
export function useWorkflowTypeahead({
  template,
  values,
}: UseWorkflowTypeaheadArgs): UseWorkflowTypeaheadResult {
  return useMemo(() => {
    let rendered = "";
    let lastFilledEnd = 0;
    const unfilled: string[] = [];
    let cursor = 0;
    PLACEHOLDER.lastIndex = 0;
    for (const m of template.matchAll(PLACEHOLDER)) {
      const name = m[1];
      const start = m.index!;
      rendered += template.slice(cursor, start);
      const v = values[name];
      if (v !== undefined && v !== "") {
        rendered += v;
        lastFilledEnd = rendered.length;
      } else {
        rendered += `{{${name}}}`;
        unfilled.push(name);
      }
      cursor = start + m[0].length;
    }
    rendered += template.slice(cursor);
    const caret = lastFilledEnd || rendered.length;
    return { rendered, caret, unfilled };
  }, [template, values]);
}
