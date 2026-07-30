import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const themesCss = readFileSync(resolve(import.meta.dirname, "themes.css"), "utf8");

describe("semantic application themes", () => {
  it("defines the full semantic contract and preserves TerminAI Dark's shell values", () => {
    for (const token of [
      "--app-canvas", "--surface-1", "--surface-2", "--surface-3",
      "--surface-overlay", "--surface-hover", "--surface-selected",
      "--text-primary", "--text-secondary", "--text-muted", "--text-inverse",
      "--border-subtle", "--border-default", "--border-strong", "--accent",
      "--accent-hover", "--accent-subtle", "--focus-ring", "--selection",
      "--status-info", "--status-success", "--status-warning", "--status-danger",
      "--status-neutral", "--terminal-background", "--terminal-foreground",
      "--editor-background", "--editor-foreground",
    ]) expect(themesCss).toContain(token);

    expect(themesCss).toMatch(/html\[data-theme="terminai-dark"\][\s\S]*?--app-canvas:\s*#0f1114/i);
    expect(themesCss).toMatch(/html\[data-theme="terminai-dark"\][\s\S]*?--text-primary:\s*#e6e1cf/i);
    expect(themesCss).toMatch(/html\[data-theme="terminai-dark"\][\s\S]*?--surface-chrome:\s*#0a0c0f/i);
    expect(themesCss).toContain("--bg-primary: var(--app-canvas)");
    expect(themesCss).toContain("--border-color: var(--border-default)");
    expect(themesCss).toContain("--accent-color: var(--accent)");
  });

  it("has readable charcoal and green-forward presets while retaining distinct status colors", () => {
    expect(themesCss).toContain('html[data-theme="slate-grey"]');
    expect(themesCss).toContain('html[data-theme="matrix"]');
    const matrix = themesCss.slice(themesCss.indexOf('html[data-theme="matrix"]'));
    expect(matrix).toMatch(/--status-success:\s*#[0-9a-f]{6}/i);
    expect(matrix).toMatch(/--status-warning:\s*#[0-9a-f]{6}/i);
    expect(matrix).toMatch(/--status-danger:\s*#[0-9a-f]{6}/i);
    expect(matrix).toContain("pointer-events: none");
    expect(matrix).toContain("prefers-reduced-motion: reduce");
  });
});
