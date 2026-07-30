import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const checker = resolve("scripts/check-theme-contrast.mjs");
const temporaryDirectories: string[] = [];

const accessibleTokens = {
  "--app-canvas": "#000000",
  "--surface-1": "#000000",
  "--surface-2": "#000000",
  "--surface-3": "#000000",
  "--surface-overlay": "#000000",
  "--surface-input": "#000000",
  "--surface-recording": "#000000",
  "--surface-recording-inset": "#000000",
  "--surface-recording-control": "#000000",
  "--surface-recording-hover": "#000000",
  "--text-primary": "#FFFFFF",
  "--text-body": "#FFFFFF",
  "--text-secondary": "#FFFFFF",
  "--text-muted": "#FFFFFF",
  "--text-recording": "#FFFFFF",
  "--text-recording-muted": "#FFFFFF",
  "--accent": "#FFFFFF",
  "--text-on-strong-accent": "#000000",
  "--status-info": "#FFFFFF",
  "--status-success": "#FFFFFF",
  "--status-warning": "#FFFFFF",
  "--status-danger": "#FFFFFF",
  "--status-neutral": "#FFFFFF",
  "--status-danger-surface": "#000000",
  "--status-warning-surface": "#000000",
  "--status-recording-failure-surface": "#000000",
  "--status-recording-failure-text": "#FFFFFF",
  "--troubleshoot-running": "#FFFFFF",
  "--troubleshoot-running-surface": "#000000",
  "--tftp-running": "#FFFFFF",
  "--tftp-running-surface": "#000000",
  "--tftp-error": "#FFFFFF",
  "--tftp-error-surface": "#000000",
  "--terminal-background": "#000000",
  "--terminal-foreground": "#FFFFFF",
  "--editor-background": "#000000",
  "--editor-foreground": "#FFFFFF",
  "--focus-ring": "#FFFFFF",
  "--focus-control": "#FFFFFF",
} as const;

function themeFixture(overrides: Partial<Record<keyof typeof accessibleTokens, string>> = {}) {
  const declarations = Object.entries({ ...accessibleTokens, ...overrides })
    .map(([token, value]) => `  ${token}: ${value};`)
    .join("\n");
  return [
    `html[data-theme="terminai-dark"] {\n${declarations}\n}`,
    `html[data-theme="slate-grey"] {\n${declarations}\n}`,
    `html[data-theme="matrix"] {\n${declarations}\n}`,
  ].join("\n\n");
}

function fixture(css: string) {
  const directory = mkdtempSync(join(tmpdir(), "terminai-theme-contrast-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "themes.css");
  writeFileSync(path, css);
  return path;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("theme contrast release checker", () => {
  it("accepts a complete palette whose mapped text and controls meet WCAG thresholds", () => {
    const result = spawnSync(process.execPath, [checker, "--css", fixture(themeFixture())], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Theme contrast check passed");
  });

  it("reports the theme, semantic pair, measured ratio, and required threshold", () => {
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture({ "--text-muted": "#595959" }))],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("terminai-dark");
    expect(result.stderr).toContain("--text-muted on --surface-3");
    expect(result.stderr).toMatch(/ratio \d+\.\d{2}, requires 4\.50/);
  });

  it("rejects unreadable ordinary text on strong action accents", () => {
    const result = spawnSync(
      process.execPath,
      [
        checker,
        "--css",
        fixture(themeFixture({ "--text-on-strong-accent": "#FFFFFF" })),
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--text-on-strong-accent on --accent");
    expect(result.stderr).toContain("requires 4.50");
  });

  it("passes the repository's three shipped application themes", () => {
    expect(() => {
      execFileSync(process.execPath, [checker], { encoding: "utf8", stdio: "pipe" });
    }).not.toThrow();
  });
});
