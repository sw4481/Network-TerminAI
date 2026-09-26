import type { ClassifiedDelta, ExpectedDelta, ApprovedMatch, SeverityCounts } from "./changeVerify";

function pathMatchesSegment(path: string, needle: string): boolean {
  const segs = path.replace(/^\//, "").split("/");
  const needleSegs = needle.replace(/^\//, "").split("/").filter(s => s.length > 0);
  if (needleSegs.length === 0 || needleSegs.length > segs.length) return false;
  for (let i = 0; i <= segs.length - needleSegs.length; i++) {
    if (segs.slice(i, i + needleSegs.length).every((s, j) => s === needleSegs[j])) return true;
  }
  return false;
}

export function reclassifyWithApprovals(
  deltas: ClassifiedDelta[],
  approved: ExpectedDelta[],
): { deltas: ClassifiedDelta[]; matched: ApprovedMatch[] } {
  const matched: ApprovedMatch[] = [];
  const out = deltas.map(d => {
    for (const a of approved) {
      if (a.command_substring.length < 3 || a.path_substring.length < 3) continue;
      if (!d.command.includes(a.command_substring)) continue;
      if (!pathMatchesSegment(d.path, a.path_substring)) continue;
      matched.push({ delta_path: d.path, command: d.command, note: a.note });
      return { ...d, severity: "green" as const, message: `(approved) ${a.note}` };
    }
    return d;
  });
  return { deltas: out, matched };
}

export function recountSeverities(deltas: ClassifiedDelta[]): SeverityCounts {
  const c: SeverityCounts = { red: 0, yellow: 0, green: 0 };
  for (const d of deltas) c[d.severity]++;
  return c;
}
