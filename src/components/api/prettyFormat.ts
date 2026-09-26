/**
 * Turn a JSON value into a YAML-like, human-scannable string.
 *
 * Design goals:
 *   - No quote marks, no braces, no commas. The Body tab already shows
 *     canonical JSON for devs; this view is for skimming.
 *   - Scalars inline with their key: `name: Acme HQ`.
 *   - Objects nested by indentation.
 *   - Arrays: primitives get "- x", objects get "- key: val" (first key
 *     on the dash line, rest indented below).
 *   - Empty collections printed as `(empty)` instead of `[]` / `{}`.
 *   - null/undefined printed as `(none)`.
 *   - ISO-8601 timestamp strings are converted to a local-friendly form.
 *
 * Stable (alphabetical) key order inside objects so successive renders
 * don't reshuffle under the user's eye.
 */

const INDENT = "  ";
const ISO_8601 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

function isPrimitive(v: unknown): v is string | number | boolean | null {
  return (
    v === null ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean"
  );
}

/**
 * Format a single scalar for inline rendering (after "key: " or after "- ").
 * Strings are emitted bare unless they carry characters that would make the
 * output ambiguous (colons, leading/trailing whitespace, newlines).
 */
function renderScalar(v: unknown): string {
  if (v === null || v === undefined) return "(none)";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") {
    if (v === "") return "(empty)";
    if (ISO_8601.test(v)) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleString();
      }
    }
    // Multi-line strings get a pipe marker + indented body on subsequent
    // lines. Handled by the caller — here we just pass through with a
    // sentinel that split-on-newline logic can detect.
    if (v.includes("\n")) {
      return v;
    }
    return v;
  }
  return String(v);
}

/**
 * Render a single key/value pair, or a single array element.
 * `prefix` is what appears before the value — `"key: "` for objects,
 * `"- "` for array items, `""` at top level.
 *
 * For scalar values returns a single line. For nested objects/arrays
 * returns the prefix line plus an indented multi-line block.
 */
function renderEntry(prefix: string, value: unknown, indent: number): string {
  const pad = INDENT.repeat(indent);
  if (isPrimitive(value) || value === undefined) {
    const rendered = renderScalar(value);
    // Multi-line string: anchor the prefix on its own line with " |",
    // then indent each body line.
    if (typeof value === "string" && value.includes("\n")) {
      const body = value
        .split("\n")
        .map((line) => `${pad}${INDENT}${line}`)
        .join("\n");
      return `${pad}${prefix}|\n${body}`;
    }
    return `${pad}${prefix}${rendered}`;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}${prefix}(empty)`;
    const itemLines: string[] = [];
    for (const item of value) {
      itemLines.push(renderEntry("- ", item, indent + 1));
    }
    return `${pad}${prefix}\n${itemLines.join("\n")}`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    if (entries.length === 0) return `${pad}${prefix}(empty)`;

    // Special case: when this is an array item (prefix === "- ") we want
    // the FIRST key on the dash line, not on a new line below it:
    //
    //   - id: L_1
    //     name: HQ
    //
    // rather than:
    //
    //   -
    //     id: L_1
    //     name: HQ
    if (prefix === "- ") {
      const [firstK, firstV] = entries[0];
      const firstLine = renderEntry(`${firstK}: `, firstV, 0);
      const rest = entries
        .slice(1)
        .map(([k, v]) => renderEntry(`${k}: `, v, indent + 1))
        .join("\n");
      // `firstLine` is at indent 0; reattach our pad + "- " in front,
      // then append the rest (which already carries indent+1's pad).
      return rest
        ? `${pad}- ${firstLine}\n${rest}`
        : `${pad}- ${firstLine}`;
    }

    const lines = entries.map(([k, v]) =>
      renderEntry(`${k}: `, v, indent + 1),
    );
    return prefix
      ? `${pad}${prefix}\n${lines.join("\n")}`
      : lines.join("\n");
  }

  return `${pad}${prefix}${String(value)}`;
}

/**
 * Entry point. Returns the YAML-ish rendering of a JSON value.
 *
 * For a top-level ARRAY of primitives, returns bullets without any
 * leading key. For a top-level OBJECT, returns one "key: value" line
 * per entry. For a top-level scalar, returns the scalar rendered plainly.
 */
export function prettyFormat(value: unknown): string {
  if (isPrimitive(value) || value === undefined) {
    return renderScalar(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return "(empty)";
    return value.map((item) => renderEntry("- ", item, 0)).join("\n");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    if (entries.length === 0) return "(empty)";
    return entries.map(([k, v]) => renderEntry(`${k}: `, v, 0)).join("\n");
  }
  return String(value);
}
