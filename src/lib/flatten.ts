export function isListOfDicts(data: unknown): data is Record<string, unknown>[] {
  return (
    Array.isArray(data) &&
    data.length > 0 &&
    data.every((r) => typeof r === "object" && r !== null && !Array.isArray(r))
  );
}

export interface FlatRow {
  key: string;
  value: unknown;
}

export function flattenToRows(data: unknown, prefix = ""): FlatRow[] {
  if (data === null || data === undefined) {
    return [{ key: prefix || "$", value: data }];
  }
  if (typeof data !== "object" || Array.isArray(data)) {
    return [{ key: prefix || "$", value: data }];
  }
  const entries = Object.entries(data as Record<string, unknown>);
  if (entries.length === 0) {
    return [{ key: prefix || "$", value: data }];
  }
  const rows: FlatRow[] = [];
  for (const [k, v] of entries) {
    const nextKey = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      rows.push(...flattenToRows(v, nextKey));
    } else {
      rows.push({ key: nextKey, value: v });
    }
  }
  return rows;
}

export function inferColumns(rows: Record<string, unknown>[]): string[] {
  const cols: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}
