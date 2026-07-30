import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
  "--text-inverse": "#FFFFFF",
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

function sourceFixture(files: Record<string, string>) {
  const directory = mkdtempSync(join(tmpdir(), "terminai-theme-usage-"));
  temporaryDirectories.push(directory);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(directory, name);
    mkdirSync(resolve(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return directory;
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

  it("does not satisfy required theme tokens with declarations inside comments", () => {
    const css = themeFixture().replace(
      "  --text-muted: #FFFFFF;",
      "  /* --text-muted: #FFFFFF; */",
    );
    const result = spawnSync(process.execPath, [checker, "--css", fixture(css)], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("terminai-dark: missing --text-muted");
  });

  it("audits active rule-level foreground/background usage with deterministic context", () => {
    const sourceRoot = sourceFixture({
      "components/Problem.css": `
.problem,
.problem--compact {
  background: var(--surface-2);
  color: var(--surface-2);
  font-size: 13px;
}
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("components/Problem.css:2");
    expect(result.stderr).toContain(".problem, .problem--compact");
    expect(result.stderr).toContain("--surface-2 on --surface-2");
    expect(result.stderr).toContain("requires 4.50");
  });

  it("checks small action text against its real accent background", () => {
    const sourceRoot = sourceFixture({
      "Action.css": `
.action {
  background: var(--accent);
  color: var(--text-inverse);
  font-size: 13px;
  font-weight: 500;
}
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Action.css:2");
    expect(result.stderr).toContain(".action");
    expect(result.stderr).toContain("--text-inverse on --accent");
    expect(result.stderr).toContain("requires 4.50");
  });

  it("ignores commented-out rules and reports the discovered active usage count", () => {
    const sourceRoot = sourceFixture({
      "CommentAware.css": `
/* .dead { color: var(--surface-2); background: var(--surface-2); } */
.live {
  color: var(--text-primary);
  background-color: var(--surface-2);
}
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("41 semantic pairs");
    expect(result.stdout).toContain("1 discovered rule-level usage");
  });

  it("resolves nested var fallbacks and color-mix inside active container rules", () => {
    const sourceRoot = sourceFixture({
      "Nested.css": `
@media (min-width: 1px) {
  .mixed {
    color: var(--missing-foreground, var(--text-primary));
    background: color-mix(in srgb, var(--text-primary) 90%, var(--surface-2));
    font-size: 12px;
  }
}
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Nested.css:3 .mixed");
    expect(result.stderr).toContain("ratio");
    expect(result.stderr).not.toContain("unsupported background expression");
  });

  it("fails closed with contextual diagnostics for an unsupported flat color expression", () => {
    const sourceRoot = sourceFixture({
      "Unsupported.css": `
.unsupported {
  color: var(--text-primary);
  background-color: hsl(120 20% 20%);
}
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported.css:2 .unsupported");
    expect(result.stderr).toContain("unsupported background expression: hsl(120 20% 20%)");
    expect(result.stderr).toContain("1 unsupported");
  });

  it("counts image backgrounds as explicit non-flat exclusions", () => {
    const sourceRoot = sourceFixture({
      "Image.css": `
.illustrated {
  color: var(--text-primary);
  background: linear-gradient(var(--surface-2), var(--surface-3));
}
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("0 discovered rule-level usages");
    expect(result.stdout).toContain("1 explicitly excluded non-flat/inherited usage");
  });

  it("passes the repository's three shipped application themes", () => {
    expect(() => {
      execFileSync(process.execPath, [checker], { encoding: "utf8", stdio: "pipe" });
    }).not.toThrow();
  });
});
