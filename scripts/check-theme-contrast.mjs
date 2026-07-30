#!/usr/bin/env node
/**
 * Deterministic WCAG contrast gate for the named foreground/background pairs
 * in TerminAI's three bundled application themes.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const THEME_IDS = ["terminai-dark", "slate-grey", "matrix"];

const NORMAL_TEXT_PAIRS = [
  ["--text-primary", "--app-canvas"],
  ["--text-primary", "--surface-1"],
  ["--text-primary", "--surface-2"],
  ["--text-primary", "--surface-3"],
  ["--text-primary", "--surface-overlay"],
  ["--text-primary", "--surface-input"],
  ["--text-body", "--app-canvas"],
  ["--text-body", "--surface-2"],
  ["--text-body", "--surface-3"],
  ["--text-secondary", "--app-canvas"],
  ["--text-secondary", "--surface-2"],
  ["--text-secondary", "--surface-3"],
  ["--text-muted", "--app-canvas"],
  ["--text-muted", "--surface-2"],
  ["--text-muted", "--surface-3"],
  ["--text-recording", "--surface-recording"],
  ["--text-recording", "--surface-recording-control"],
  ["--text-recording", "--surface-recording-hover"],
  ["--text-recording-muted", "--surface-recording"],
  ["--text-recording-muted", "--surface-recording-inset"],
  ["--text-recording-muted", "--surface-recording-control"],
  ["--text-recording-muted", "--surface-recording-hover"],
  ["--status-info", "--surface-1"],
  ["--status-success", "--surface-1"],
  ["--status-warning", "--status-warning-surface"],
  ["--status-danger", "--status-danger-surface"],
  ["--status-neutral", "--surface-1"],
  ["--status-recording-failure-text", "--status-recording-failure-surface"],
  ["--troubleshoot-running", "--troubleshoot-running-surface", "--surface-1"],
  ["--tftp-running", "--tftp-running-surface"],
  ["--tftp-error", "--tftp-error-surface"],
  ["--terminal-foreground", "--terminal-background"],
  ["--editor-foreground", "--editor-background"],
].map(([foreground, background, backdrop]) => ({
  foreground,
  background,
  backdrop,
  minimum: 4.5,
}));

const UI_CONTROL_PAIRS = [
  ["--focus-ring", "--app-canvas"],
  ["--focus-ring", "--surface-1"],
  ["--focus-ring", "--surface-2"],
  ["--focus-ring", "--surface-3"],
  ["--focus-ring", "--surface-input"],
  ["--focus-control", "--app-canvas"],
  ["--focus-control", "--surface-2"],
].map(([foreground, background]) => ({ foreground, background, minimum: 3 }));

export const CONTRAST_PAIRS = [...NORMAL_TEXT_PAIRS, ...UI_CONTROL_PAIRS];

function channelToLinear(channel) {
  const normalized = channel / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function parseColor(color) {
  const hex = color.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    return {
      red: Number.parseInt(hex[1].slice(0, 2), 16),
      green: Number.parseInt(hex[1].slice(2, 4), 16),
      blue: Number.parseInt(hex[1].slice(4, 6), 16),
      alpha: 1,
    };
  }
  const rgb = color.match(
    /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*(\d+(?:\.\d+)?)%)?\s*\)$/i,
  );
  if (rgb) {
    return {
      red: Number(rgb[1]),
      green: Number(rgb[2]),
      blue: Number(rgb[3]),
      alpha: rgb[4] == null ? 1 : Number(rgb[4]) / 100,
    };
  }
  throw new Error(`Expected a hex or modern rgb color, received ${color}`);
}

function composite(foreground, background) {
  return {
    red: foreground.red * foreground.alpha + background.red * (1 - foreground.alpha),
    green: foreground.green * foreground.alpha + background.green * (1 - foreground.alpha),
    blue: foreground.blue * foreground.alpha + background.blue * (1 - foreground.alpha),
    alpha: 1,
  };
}

export function relativeLuminance(color, backdrop) {
  let parsed = parseColor(color);
  if (parsed.alpha < 1) {
    if (!backdrop) throw new Error(`Translucent color ${color} requires a backdrop`);
    parsed = composite(parsed, parseColor(backdrop));
  }
  const red = channelToLinear(parsed.red);
  const green = channelToLinear(parsed.green);
  const blue = channelToLinear(parsed.blue);
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

export function contrastRatio(first, second, backdrop) {
  const firstLuminance = relativeLuminance(first, backdrop);
  const secondLuminance = relativeLuminance(second, backdrop);
  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

export function parseThemeTokens(css) {
  const themes = new Map();
  const blocks = css.matchAll(
    /html\[data-theme="([^"]+)"\][^{]*\{([\s\S]*?)\n\}/g,
  );
  for (const block of blocks) {
    const tokens = themes.get(block[1]) ?? new Map();
    for (const declaration of block[2].matchAll(
      /(--[\w-]+)\s*:\s*(#[0-9a-f]{6}|rgb\([^;]+\))\s*;/gi,
    )) {
      tokens.set(declaration[1], declaration[2].toUpperCase());
    }
    themes.set(block[1], tokens);
  }
  return themes;
}

export function auditThemeContrast(css) {
  const themes = parseThemeTokens(css);
  const findings = [];
  for (const themeId of THEME_IDS) {
    const tokens = themes.get(themeId);
    if (!tokens) {
      findings.push({ themeId, error: "theme block is missing" });
      continue;
    }
    for (const pair of CONTRAST_PAIRS) {
      const foreground = tokens.get(pair.foreground);
      const background = tokens.get(pair.background);
      const backdrop = pair.backdrop ? tokens.get(pair.backdrop) : undefined;
      if (!foreground || !background || (pair.backdrop && !backdrop)) {
        findings.push({
          themeId,
          ...pair,
          error: `missing ${
            !foreground ? pair.foreground : !background ? pair.background : pair.backdrop
          }`,
        });
        continue;
      }
      const ratio = contrastRatio(foreground, background, backdrop);
      if (ratio + Number.EPSILON < pair.minimum) {
        findings.push({ themeId, ...pair, foregroundValue: foreground, backgroundValue: background, ratio });
      }
    }
  }
  return findings;
}

function printFinding(finding) {
  if (finding.error) {
    return `${finding.themeId}: ${finding.error}`;
  }
  return `${finding.themeId}: ${finding.foreground} on ${finding.background}`
    + ` is ${finding.foregroundValue} on ${finding.backgroundValue}`
    + ` (ratio ${finding.ratio.toFixed(2)}, requires ${finding.minimum.toFixed(2)})`;
}

function main() {
  const args = process.argv.slice(2);
  const cssIndex = args.indexOf("--css");
  const cssPath = resolve(cssIndex >= 0 ? args[cssIndex + 1] : "src/theme/themes.css");
  const findings = auditThemeContrast(readFileSync(cssPath, "utf8"));
  if (findings.length) {
    console.error("Theme contrast check failed:");
    for (const finding of findings) console.error(`  ${printFinding(finding)}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Theme contrast check passed: ${THEME_IDS.length} themes, ${CONTRAST_PAIRS.length} semantic pairs.`);
}

if (import.meta.url === new URL(`file://${resolve(process.argv[1] ?? "")}`).href) {
  main();
}
