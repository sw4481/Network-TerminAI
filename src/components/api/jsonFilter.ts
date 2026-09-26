import { JSONPath } from "jsonpath-plus";

export type FilterResult =
  | { kind: "empty"; value: unknown }
  | { kind: "ok"; value: unknown }
  | { kind: "error"; message: string };

/**
 * Apply a JSONPath expression to the given JSON value.
 *
 * - Empty / whitespace filter → passthrough ({ kind: "empty" })
 * - Valid expression → filtered result ({ kind: "ok" })
 * - Invalid expression → { kind: "error", message }
 *
 * We use `jsonpath-plus` which is permissive about the leading `$`: both
 * `$.foo.bar` and `foo.bar` work. We coerce the result through a simple
 * rule: if the query yields a single item, return that item directly
 * (matches how JQ users think about `.[0]`); otherwise return the array.
 */
export function applyFilter(filter: string, json: unknown): FilterResult {
  const trimmed = filter.trim();
  if (!trimmed) return { kind: "empty", value: json };
  try {
    const path = trimmed.startsWith("$") ? trimmed : `$.${trimmed}`;
    // jsonpath-plus's type overloads don't play nicely with `unknown`
    // inputs — coerce through `unknown` on both sides.
    const raw = JSONPath({
      path,
      json: json as object,
      wrap: true,
    }) as unknown;
    const result = Array.isArray(raw) ? (raw as unknown[]) : [raw];
    // Normalize: single-element wrap → unwrap.
    if (result.length === 1) {
      return { kind: "ok", value: result[0] };
    }
    return { kind: "ok", value: result };
  } catch (err) {
    return {
      kind: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
