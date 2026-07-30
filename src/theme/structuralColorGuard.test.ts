import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const created: string[] = [];
const guard = join(process.cwd(), "scripts/check-structural-colors.mjs");

function fixture(source: string, allowlist = { entries: [] }) {
  const directory = mkdtempSync(join(process.cwd(), "src/components/.color-guard-"));
  created.push(directory);
  const file = join(directory, "GuardFixture.tsx");
  const allowlistFile = join(directory, "allowlist.json");
  writeFileSync(file, source);
  writeFileSync(allowlistFile, JSON.stringify(allowlist));
  return { file, allowlistFile, logicalFile: relative(process.cwd(), file) };
}

function check(file: string, allowlistFile: string) {
  return () => execFileSync("node", [guard, "--check-file", file, "--allowlist", allowlistFile], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("structural color guard", () => {
  it("rejects arbitrary CSS/TSX literals with file, line, property, and value", () => {
    const f = fixture('const style = { background: "#123456" };\n');
    expect(check(f.file, f.allowlistFile)).toThrow(/GuardFixture\.tsx:1 #123456 property=background/);
  });

  it("accepts only an exact machine-readable topology domain entry", () => {
    const pending = fixture('const topologyLink = { stroke: "#d4a857" }; // topology-link\n');
    writeFileSync(pending.allowlistFile, JSON.stringify({ entries: [{
      path: pending.logicalFile,
      value: "#d4a857",
      property: "stroke",
      context: "topology-link",
      role: "topology link health",
    }] }));
    expect(check(pending.file, pending.allowlistFile)).not.toThrow();
  });

  it("rejects an approved domain value when it is misused as structural chrome", () => {
    const pending = fixture('const topologyLink = { background: "#d4a857" }; // topology-link\n');
    writeFileSync(pending.allowlistFile, JSON.stringify({ entries: [{
      path: pending.logicalFile,
      value: "#d4a857",
      property: "stroke",
      context: "topology-link",
      role: "topology link health",
    }] }));
    expect(check(pending.file, pending.allowlistFile)).toThrow(/property=background/);
  });

  it("includes untracked source files when the requested base resolves to HEAD", () => {
    const f = fixture('const style = { color: "#123456" };\n');
    expect(() => execFileSync("node", [guard, "--base", "HEAD"], {
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow(new RegExp(`${f.logicalFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:1 #123456`));
  });

  it("uses merge-base semantics for an explicit diverged-base revision", () => {
    expect(() => execFileSync("node", [guard, "--base", "origin/main"], {
      encoding: "utf8",
      stdio: "pipe",
    })).not.toThrow();
  });
});
