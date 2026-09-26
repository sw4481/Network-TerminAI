import type { ReportSummary } from "./changeVerify";

export interface MarkdownMeta {
  bundleName: string;
  capturedAt: number;
}

export function renderReportMarkdown(r: ReportSummary, m: MarkdownMeta): string {
  const d = new Date(m.capturedAt * 1000).toISOString();
  const lines: string[] = [];
  lines.push(`# Change Verification Report`);
  lines.push(``);
  lines.push(`**Bundle:** ${m.bundleName}`);
  lines.push(`**Generated:** ${d}`);
  lines.push(`**Pre snapshot:** \`${r.pre_snapshot_id}\``);
  lines.push(`**Post snapshot:** \`${r.post_snapshot_id}\``);
  if (r.notes) { lines.push(``); lines.push(`> ${r.notes}`); }
  lines.push(``);
  lines.push(`## Severity counts`);
  lines.push(`- Red: ${r.counts.red}`);
  lines.push(`- Yellow: ${r.counts.yellow}`);
  lines.push(`- Green: ${r.counts.green}`);
  lines.push(``);
  if (r.matched_approved.length > 0) {
    lines.push(`## Approved deltas`);
    for (const a of r.matched_approved) {
      lines.push(`- \`${a.command}\` @ \`${a.delta_path}\` — ${a.note}`);
    }
    lines.push(``);
  }
  lines.push(`## Deltas by command`);
  const byCmd = new Map<string, typeof r.deltas>();
  for (const dl of r.deltas) {
    if (!byCmd.has(dl.command)) byCmd.set(dl.command, []);
    byCmd.get(dl.command)!.push(dl);
  }
  for (const [cmd, rows] of byCmd) {
    lines.push(`### \`${cmd}\``);
    lines.push(``);
    lines.push(`| Severity | Path | Before | After | Message |`);
    lines.push(`|---|---|---|---|---|`);
    for (const dl of rows) {
      const sev = dl.severity.toUpperCase();
      const before = escapePipe(JSON.stringify(dl.before).slice(0, 60));
      const after = escapePipe(JSON.stringify(dl.after).slice(0, 60));
      const message = escapePipe(dl.message);
      lines.push(`| ${sev} | \`${dl.path}\` | \`${before}\` | \`${after}\` | ${message} |`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

// Escape characters that would break a markdown table cell.
function escapePipe(s: string): string {
  return s
    .replace(/\\/g, "\\\\")  // backslash MUST be first to avoid double-escaping
    .replace(/`/g, "\\`")     // backtick — would close the inline-code span
    .replace(/\|/g, "\\|")    // pipe — would split the table cell
    .replace(/\n/g, " ");     // newline — would break the row
}
