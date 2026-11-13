import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Importing the actual config validates inputs without launching Vite or Chromium.
function config(output?: string, chromium = process.execPath) {
  return () => JSON.parse(execFileSync("bun", ["-e", 'import c from "./e2e/telemetry/playwright.config.ts"; console.log(JSON.stringify(c))'], {
    cwd: process.cwd(),
    env: { ...process.env, TELEMETRY_E2E_OUTPUT: output ?? "", TELEMETRY_E2E_CHROMIUM: chromium, TEST_WORKER_INDEX: undefined },
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }));
}
function fresh() {
  const output = mkdtempSync(join("/tmp", "ccie-telemetry-task12."));
  mkdirSync(join(output, "tmp"));
  return output;
}
describe("Telemetry browser config input boundary", () => {
  it("runs the installed PATH Bun with a fresh task12 output and refuses server reuse", () => {
    const c = config(fresh())();
    expect(c.webServer.command).toMatch(/^NODE_ENV=development bun /);
    expect(c.webServer.reuseExistingServer).toBe(false);
    expect(c.webServer.command).toContain("--strictPort");
  });
  it("rejects missing output, missing Chromium and previously populated artifacts", () => {
    expect(config()).toThrow();
    expect(config(fresh(), "/nonexistent-telemetry-chromium")).toThrow();
    const output = fresh();
    writeFileSync(join(output, "previous-result"), "old");
    expect(config(output)).toThrow();
  });
  it("rejects symlink artifact roots and temporary directories", () => {
    const output = fresh(), parent = mkdtempSync(join("/tmp", "telemetry-config-guard."));
    const link = `/tmp/ccie-telemetry-task12.${randomUUID().replaceAll("-", "")}`;
    symlinkSync(output, link);
    expect(config(link)).toThrow();
    const linkedTmp = mkdtempSync(join("/tmp", "ccie-telemetry-task12."));
    symlinkSync(parent, join(linkedTmp, "tmp"));
    expect(config(linkedTmp)).toThrow();
  });
});
