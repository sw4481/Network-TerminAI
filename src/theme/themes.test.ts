import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const themesCss = readFileSync(resolve(import.meta.dirname, "themes.css"), "utf8");
const appCss = readFileSync(resolve(import.meta.dirname, "../App.css"), "utf8");

function firstRule(selector: string): string {
  const start = appCss.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector}`);
  const end = appCss.indexOf("}", start);
  return appCss.slice(start, end + 1);
}

function lastRule(selector: string): string {
  const start = appCss.lastIndexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing ${selector}`);
  const end = appCss.indexOf("}", start);
  return appCss.slice(start, end + 1);
}

describe("semantic application themes", () => {
  it("defines the full semantic contract and preserves TerminAI Dark's shell values", () => {
    for (const token of [
      "--app-canvas", "--surface-1", "--surface-2", "--surface-3",
      "--surface-overlay", "--surface-hover", "--surface-selected",
      "--text-primary", "--text-secondary", "--text-muted", "--text-inverse",
      "--border-subtle", "--border-default", "--border-strong", "--accent",
      "--accent-hover", "--text-on-accent-hover", "--accent-subtle", "--focus-ring", "--selection",
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

  it("keeps Dark structural values exact while core higher-specificity selectors stay theme-responsive", () => {
    expect(themesCss).toMatch(/--surface-overlay:\s*#14171c/i);
    expect(themesCss).toMatch(/--surface-terminal:\s*#1e1e1e/i);
    expect(themesCss).toMatch(/--surface-chrome:\s*#0a0c0f/i);

    expect(appCss).toMatch(/\.tab-chooser-popover\s*\{[\s\S]*?background:\s*var\(--surface-overlay\)/);
    expect(appCss).toMatch(/\.terminal-wrapper\s*\{[\s\S]*?background:\s*var\(--surface-terminal\)/);
    expect(appCss).toMatch(/\.status-footer\s*\{[\s\S]*?background:\s*var\(--surface-chrome\)/);
    expect(appCss).toMatch(/\.tab-chooser-item\s*\{[\s\S]*?color:\s*var\(--text-body\)/);
    expect(appCss).toMatch(/\.tab-chooser-item:hover\s*\{[\s\S]*?background:\s*var\(--surface-hover\)/);
    expect(appCss).toMatch(/\.json-input:focus\s*\{[\s\S]*?border-color:\s*var\(--focus-ring\)/);
    expect(appCss).toMatch(/\.status-popover-error\s*\{[\s\S]*?color:\s*var\(--status-danger\)/);
    expect(lastRule(".settings-tabs button:hover")).toContain("background: var(--surface-hover)");
    expect(lastRule(".settings-tabs button.active")).toContain("background: var(--surface-selected)");
    expect(firstRule(".modal-card.recently-closed")).toContain("background: var(--surface-overlay)");
    expect(firstRule(".status-popover-error")).toContain("color: var(--status-danger)");
    expect(lastRule(".modal-header h2")).toContain("color: var(--text-primary)");
    expect(lastRule(".error-message")).toContain("background: var(--status-danger-surface)");
    expect(lastRule(".warning-message")).toContain("background: var(--status-warning-surface)");
    expect(lastRule(".search-input")).toContain("background: var(--surface-input)");
    expect(lastRule(".search-input:focus")).toContain("border-color: var(--focus-control)");
    expect(lastRule(".search-input:focus")).toContain("background: var(--surface-input-focus)");
    expect(lastRule(".search-input::placeholder")).toContain("color: var(--text-muted)");
  });
});
