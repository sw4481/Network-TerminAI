import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const created: string[] = [];
const guard = join(process.cwd(), "scripts/check-structural-colors.mjs");

function check(source: string) {
  const directory = mkdtempSync(join(process.cwd(), "src/components/.color-guard-"));
  created.push(directory);
  const file = join(directory, "GuardFixture.tsx");
  writeFileSync(file, source);
  return () => execFileSync("node", [guard, "--check-file", file], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("structural color guard", () => {
  it("rejects a newly introduced structural palette literal with file, line, and value", () => {
    expect(check('const style = { background: "#0f1114" };\n')).toThrow(/GuardFixture\.tsx:1 #0f1114/);
  });

  it("accepts semantic tokens and approved domain/status colors", () => {
    expect(check('const style = { background: "var(--surface-1)", color: "#f44336" };\n')).not.toThrow();
    expect(check('const edge = { stroke: "#d4a857" }; // topology vendor edge\n')).not.toThrow();
  });
});
