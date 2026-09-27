/**
 * Pipe-filter syntax: `show ip route | ↗structured.<expr>`
 *
 * Supported operators:
 *   path = value       (string equality, case-insensitive)
 *   path ~ /regex/     (regex match)
 *   path in (a,b,c)    (any-of)
 *   path not in (a,b)  (none-of)
 *   jsonpath:$.foo[?]  (raw JSONPath passthrough — handled by StructuredTab)
 */

export const PIPE_SENTINEL = "| ↗structured.";

export type StructuredFilter =
  | { kind: "eq"; path: string; value: string }
  | { kind: "regex"; path: string; pattern: string; flags: string }
  | { kind: "in"; path: string; values: string[]; negated: boolean }
  | { kind: "jsonpath"; expr: string };

export interface PipeSplit {
  command: string;
  filter: StructuredFilter | null;
}

export class StructuredPipeError extends Error {}

export function splitStructuredPipe(input: string): PipeSplit {
  const idx = input.indexOf(PIPE_SENTINEL);
  if (idx < 0) return { command: input, filter: null };
  const command = input.slice(0, idx).trimEnd();
  const exprRaw = input.slice(idx + PIPE_SENTINEL.length).trim();
  if (exprRaw.length === 0) {
    throw new StructuredPipeError(
      "empty filter expression after `↗structured.`",
    );
  }
  return { command, filter: parseFilter(exprRaw) };
}

export function parseFilter(expr: string): StructuredFilter {
  const trimmed = expr.trim();
  if (trimmed.startsWith("jsonpath:")) {
    const inner = trimmed.slice("jsonpath:".length).trim();
    if (!inner) throw new StructuredPipeError("empty jsonpath expression");
    return { kind: "jsonpath", expr: inner };
  }
  // `path not in (...)` / `path in (...)`
  const inMatch = trimmed.match(/^([^\s=~]+)\s+(not\s+in|in)\s*\((.*)\)$/i);
  if (inMatch) {
    const [, path, op, listRaw] = inMatch;
    const values = listRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map(stripQuotes);
    if (values.length === 0)
      throw new StructuredPipeError("empty `in` list");
    return {
      kind: "in",
      path,
      values,
      negated: /^not\s+in$/i.test(op),
    };
  }
  // `path ~ /regex/flags` or `path ~ pattern`
  const regexMatch = trimmed.match(/^([^\s=~]+)\s*~\s*(.+)$/);
  if (regexMatch) {
    const path = regexMatch[1];
    let body = regexMatch[2].trim();
    let flags = "";
    const slashRe = body.match(/^\/(.*)\/([gimsuy]*)$/);
    if (slashRe) {
      body = slashRe[1];
      flags = slashRe[2];
    }
    // Validate regex.
    try {
      new RegExp(body, flags);
    } catch (e) {
      throw new StructuredPipeError(`invalid regex: ${(e as Error).message}`);
    }
    return { kind: "regex", path, pattern: body, flags };
  }
  // `path = value`
  const eqMatch = trimmed.match(/^([^\s=~]+)\s*=\s*(.+)$/);
  if (eqMatch) {
    return {
      kind: "eq",
      path: eqMatch[1],
      value: stripQuotes(eqMatch[2].trim()),
    };
  }
  throw new StructuredPipeError(`unrecognized filter: ${trimmed}`);
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && (s.startsWith('"') || s.startsWith("'"))) {
    const q = s[0];
    if (s.endsWith(q)) return s.slice(1, -1);
  }
  return s;
}

/**
 * Apply a structured filter to list-of-dicts rows. JSONPath filters are NOT
 * applied here — they're routed to the StructuredTab which uses
 * `jsonpath-plus`. Returns `rows` unmodified for jsonpath kind.
 */
export function applyFilter(
  rows: Record<string, unknown>[],
  filter: StructuredFilter,
): Record<string, unknown>[] {
  if (filter.kind === "jsonpath") return rows;
  return rows.filter((row) => {
    const v = row[filter.path];
    const sv = v === null || v === undefined ? "" : String(v);
    switch (filter.kind) {
      case "eq":
        return sv.toLowerCase() === filter.value.toLowerCase();
      case "regex": {
        const re = new RegExp(filter.pattern, filter.flags);
        return re.test(sv);
      }
      case "in": {
        const hit = filter.values.some(
          (x) => x.toLowerCase() === sv.toLowerCase(),
        );
        return filter.negated ? !hit : hit;
      }
    }
  });
}
