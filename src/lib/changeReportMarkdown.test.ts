import { describe, it, expect } from "vitest";
import { renderReportMarkdown } from "./changeReportMarkdown";

describe("renderReportMarkdown", () => {
  const baseReport = {
    pre_snapshot_id: "p1",
    post_snapshot_id: "p2",
    bundle_id: "b1",
    counts: { red: 1, yellow: 2, green: 3 },
    deltas: [
      { command: "show ip bgp summary", family: "bgp-neighbor", severity: "red" as const,
        path: "/neighbor/10.0.0.2/state", before: "Established", after: "Active",
        message: "BGP neighbor 10.0.0.2 state is now Active" },
    ],
    matched_approved: [],
    notes: "Migrated core router",
  };

  it("produces a report with severity counts and per-command sections", () => {
    const md = renderReportMarkdown(baseReport, { bundleName: "IOS-XE routing", capturedAt: 1715_000_000 });
    expect(md).toContain("# Change Verification Report");
    expect(md).toContain("IOS-XE routing");
    expect(md).toContain("- Red: 1");
    expect(md).toContain("BGP neighbor 10.0.0.2");
    expect(md).toContain("`/neighbor/10.0.0.2/state`");
  });

  it("escapes pipes inside table cells", () => {
    const md = renderReportMarkdown(
      { ...baseReport, deltas: [{ ...baseReport.deltas[0], message: "a|b|c" }] },
      { bundleName: "x", capturedAt: 1 },
    );
    expect(md).toContain("a\\|b\\|c");
  });

  it("includes notes when present", () => {
    const md = renderReportMarkdown(baseReport, { bundleName: "x", capturedAt: 1 });
    expect(md).toContain("> Migrated core router");
  });

  it("omits 'Approved deltas' header when none", () => {
    const md = renderReportMarkdown(baseReport, { bundleName: "x", capturedAt: 1 });
    expect(md).not.toContain("## Approved deltas");
  });

  it("includes 'Approved deltas' section when present", () => {
    const md = renderReportMarkdown(
      { ...baseReport, matched_approved: [{ delta_path: "/x", command: "show foo", note: "expected" }] },
      { bundleName: "x", capturedAt: 1 },
    );
    expect(md).toContain("## Approved deltas");
    expect(md).toContain("expected");
  });

  it("escapes backticks inside table cells", () => {
    const md = renderReportMarkdown(
      { ...baseReport, deltas: [{ ...baseReport.deltas[0], message: "value `with backtick` in it" }] },
      { bundleName: "x", capturedAt: 1 },
    );
    // Backticks should be escaped; the inline-code spans wrapping path/before/after
    // should not be prematurely closed.
    expect(md).toContain("\\`with backtick\\`");
  });
});
