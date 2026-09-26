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
  "--surface-selected": "#000000",
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
  "--accent-hover": "#FFFFFF",
  "--text-on-strong-accent": "#000000",
  "--text-on-accent-hover": "#000000",
  "--status-info": "#FFFFFF",
  "--status-success": "#FFFFFF",
  "--status-warning": "#FFFFFF",
  "--status-danger": "#FFFFFF",
  "--status-neutral": "#FFFFFF",
  "--status-recording-live": "#FFFFFF",
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
  "--risk-auto": "#00FF00",
  "--risk-tier-1": "#00FFFF",
  "--risk-tier-2": "#FFFF00",
  "--risk-tier-3": "#FF0000",
  "--risk-ambiguous": "#FF00FF",
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

const validVisualStateFiles = {
  "App.css": `
.tab-recording-dot { background-color: var(--status-recording-live); }
.tab-activity-dot--needs-attention { background-color: var(--status-danger); }
.tab-activity-dot--running { background-color: var(--status-warning); }
`,
  "components/BlastRadius/BlastRadius.css": `
.br-tier-badge.tier-1 { border-color: var(--risk-tier-1); }
.br-tier-badge.tier-2 { border-color: var(--risk-tier-2); }
.br-tier-badge.tier-3 { border-color: var(--risk-tier-3); }
.br-tier-badge.tier-amb { border-color: var(--risk-ambiguous); }
`,
  "components/DriftSidebar.css": `
.drift-status-dot.in_sync { background-color: var(--risk-auto); }
.drift-status-dot.drift { background-color: var(--risk-tier-2); }
.drift-status-dot.error { background-color: var(--risk-tier-3); }
.drift-status-dot.paused { background-color: var(--risk-ambiguous); }
`,
  "components/BlastRadius/RuleEditor.css": `
.rule-editor .badge.tier-0 { border-color: var(--risk-auto); }
.rule-editor .badge.tier-1 { border-color: var(--risk-tier-1); }
.rule-editor .badge.tier-2 { border-color: var(--risk-tier-2); }
.rule-editor .badge.tier-3 { border-color: var(--risk-tier-3); }
`,
} as const;

function sourceFixture(
  files: Record<string, string>,
  omittedContractFiles: string[] = [],
) {
  const directory = mkdtempSync(join(tmpdir(), "terminai-theme-usage-"));
  temporaryDirectories.push(directory);
  const contractFiles = Object.fromEntries(
    Object.entries(validVisualStateFiles).filter(
      ([name]) => !omittedContractFiles.includes(name),
    ),
  );
  for (const [name, contents] of Object.entries({ ...contractFiles, ...files })) {
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

  it("rejects unreadable ordinary text on hover accents", () => {
    const result = spawnSync(
      process.execPath,
      [
        checker,
        "--css",
        fixture(themeFixture({ "--text-on-accent-hover": "#FFFFFF" })),
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--text-on-accent-hover on --accent-hover");
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
    expect(result.stdout).toContain("42 semantic pairs");
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

  it("audits a hover background against the foreground inherited from its base rule", () => {
    const sourceRoot = sourceFixture({
      "State.css": `
.action {
  color: var(--text-primary);
  background: var(--surface-2);
}
.action:hover:not(:disabled) {
  background: var(--text-primary);
}
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("State.css:6 .action:hover:not(:disabled)");
    expect(result.stderr).toContain("--text-primary on --text-primary");
    expect(result.stderr).toContain("1 derived state usage");
  });

  it("splits comma selectors and pairs each state branch with only its compatible base", () => {
    const sourceRoot = sourceFixture({
      "Aligned.css": `
.alpha,
.beta {
  color: var(--text-primary);
  background: var(--surface-2);
}
.alpha:hover,
.beta:focus-visible {
  background: var(--text-primary);
}
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Aligned.css:7 .alpha:hover");
    expect(result.stderr).toContain("Aligned.css:7 .beta:focus-visible");
    expect(result.stderr).not.toContain(".alpha:hover, .beta:focus-visible:");
    expect(result.stderr).toContain("2 derived state usages");
  });

  it("recognizes supported interactive pseudo-classes and state attributes", () => {
    const sourceRoot = sourceFixture({
      "Interactive.css": `
.control,
.group .control {
  color: var(--text-primary);
  background: var(--surface-2);
}
.control:hover:not(:disabled),
.control:focus,
.control:focus-visible,
.group:focus-within .control,
.control:active,
.control:disabled,
.control:checked,
.control[aria-pressed="true"] {
  background: var(--surface-2);
}
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("8 derived state usages");
    expect(result.stdout).toContain("0 cascade exclusions");
  });

  it("uses the final compatible state declarations for foreground and background", () => {
    const sourceRoot = sourceFixture({
      "Overrides.css": `
.color-shift,
.background-shift {
  color: var(--text-primary);
  background: var(--surface-2);
}
.color-shift:hover {
  background: var(--text-primary);
}
.background-shift:focus {
  color: var(--surface-2);
}
.color-shift:hover {
  color: var(--surface-2);
}
.background-shift:focus {
  background: var(--text-primary);
}
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("2 derived state usages");
  });

  it("honors a later state background-color over an earlier background shorthand", () => {
    const sourceRoot = sourceFixture({
      "Shorthand.css": `
.action {
  color: var(--text-primary);
  background-color: var(--surface-2);
  background: var(--surface-2);
}
.action:hover {
  background-color: var(--text-primary);
}
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Shorthand.css:7 .action:hover");
    expect(result.stderr).toContain("--text-primary on --text-primary");
  });

  it("does not merge unrelated selectors and explicitly counts an unpaired state", () => {
    const sourceRoot = sourceFixture({
      "Unpaired.css": `
.alpha {
  color: var(--text-primary);
}
.beta:hover {
  background: var(--surface-2);
}
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("0 derived state usages");
    expect(result.stdout).toContain("1 cascade exclusion");
  });

  it("fails the visual-state contract when a required operational selector is missing", () => {
    const sourceRoot = sourceFixture({
      "App.css": `
.tab-recording-dot { background-color: var(--status-recording-live); }
.tab-activity-dot--running { background-color: var(--status-warning); }
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tab operational indicators");
    expect(result.stderr).toContain(".tab-activity-dot--needs-attention");
    expect(result.stderr).toContain("missing background paint");
  });

  it("fails closed when a contracted visual-state CSS file is missing", () => {
    const sourceRoot = sourceFixture(
      {},
      ["components/BlastRadius/RuleEditor.css"],
    );
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Blast Radius rule tiers");
    expect(result.stderr).toContain("components/BlastRadius/RuleEditor.css");
    expect(result.stderr).toContain("missing contracted CSS file");
  });

  it("fails when distinct Blast Radius tiers resolve to the same visible paint", () => {
    const sourceRoot = sourceFixture({
      "components/BlastRadius/BlastRadius.css": `
.br-tier-badge.tier-1 { border-color: var(--risk-tier-1); }
.br-tier-badge.tier-2 { border-color: var(--risk-tier-1); }
.br-tier-badge.tier-3 { border-color: var(--risk-tier-3); }
.br-tier-badge.tier-amb { border-color: var(--risk-ambiguous); }
`,
    });
    const result = spawnSync(
      process.execPath,
      [checker, "--css", fixture(themeFixture()), "--src", sourceRoot],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Blast Radius tiers");
    expect(result.stderr).toContain("tier-1 and tier-2");
    expect(result.stderr).toContain("must resolve to distinct paints");
  });

  it("fails when an operational indicator is distinct but below 3:1 on its real tab surface", () => {
    const sourceRoot = sourceFixture({
      "App.css": `
.tab-recording-dot { background-color: var(--status-recording-live); }
.tab-activity-dot--needs-attention { background-color: var(--status-danger); }
.tab-activity-dot--running { background-color: var(--status-warning); }
`,
    });
    const result = spawnSync(
      process.execPath,
      [
        checker,
        "--css",
        fixture(themeFixture({
          "--status-warning": "#555555",
          "--status-warning-surface": "#FFFFFF",
        })),
        "--src",
        sourceRoot,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tab operational indicators");
    expect(result.stderr).toContain(".tab-activity-dot--running");
    expect(result.stderr).toContain("requires 3.00");
  });

  it("passes the repository's three shipped application themes", () => {
    const output = execFileSync(process.execPath, [checker], {
      encoding: "utf8",
      stdio: "pipe",
    });

    expect(output).toContain("15 visual-state paints");
    expect(output).toContain("4 contract groups");
  });
});
