/**
 * Minority-value outlier detection for fan-out merged diffs.
 *
 * Input rows have one entry per device. Each row is keyed by `keyColumn`
 * (e.g. `neighbor` for `show ip bgp summary`) and has additional columns
 * (e.g. `state`, `prefixes`).
 *
 * For each `(keyColumn value, other column)` pair we compute value
 * frequencies. If one value's share is >= `majorityThreshold` (default
 * 0.75) AND the rest's share is <= `minorityThreshold` (default 0.10),
 * each device whose value differs from the majority is reported as an
 * outlier — that's the "1 of 50 has BGP DOWN" case.
 */

export interface OutlierRow {
  deviceKey: string;
  columns: Record<string, string>;
}

export interface DetectOptions {
  keyColumn: string;
  majorityThreshold?: number;
  minorityThreshold?: number;
}

export interface Outlier {
  deviceKey: string;
  column: string;
  value: string;
  majorityValue: string;
  minoritySize: number;
  majoritySize: number;
}

export function detectOutliers(
  rows: OutlierRow[],
  opts: DetectOptions,
): Outlier[] {
  const majorityThreshold = opts.majorityThreshold ?? 0.75;
  const minorityThreshold = opts.minorityThreshold ?? 0.1;

  const outliers: Outlier[] = [];

  // Group rows by the value of keyColumn so we compare like-for-like (e.g.
  // same BGP neighbor across devices).
  const groups = new Map<string, OutlierRow[]>();
  for (const row of rows) {
    const k = row.columns[opts.keyColumn];
    if (k === undefined) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(row);
  }

  for (const groupRows of groups.values()) {
    if (groupRows.length < 2) continue;
    const total = groupRows.length;

    // Each non-key column gets a frequency tally.
    const cols = new Set<string>();
    for (const r of groupRows) {
      for (const c of Object.keys(r.columns)) {
        if (c !== opts.keyColumn) cols.add(c);
      }
    }

    for (const col of cols) {
      const freq = new Map<string, number>();
      for (const r of groupRows) {
        const v = r.columns[col] ?? "";
        freq.set(v, (freq.get(v) ?? 0) + 1);
      }
      // pick majority
      let majValue: string | null = null;
      let majSize = 0;
      for (const [v, n] of freq) {
        if (n > majSize) {
          majSize = n;
          majValue = v;
        }
      }
      if (majValue === null) continue;
      const majShare = majSize / total;
      if (majShare < majorityThreshold) continue;
      const minorityShare = 1 - majShare;
      if (minorityShare > minorityThreshold && total > 2) continue;

      for (const r of groupRows) {
        const v = r.columns[col] ?? "";
        if (v !== majValue) {
          outliers.push({
            deviceKey: r.deviceKey,
            column: col,
            value: v,
            majorityValue: majValue,
            minoritySize: total - majSize,
            majoritySize: majSize,
          });
        }
      }
    }
  }

  outliers.sort((a, b) => {
    const c = a.column.localeCompare(b.column);
    if (c !== 0) return c;
    const m = a.minoritySize - b.minoritySize;
    if (m !== 0) return m;
    return a.deviceKey.localeCompare(b.deviceKey);
  });

  return outliers;
}
