#!/usr/bin/env node
/**
 * Reject palette literals added to feature CSS/TSX.  Existing historical
 * literals are deliberately not grandfathered: the normal mode examines the
 * merge-base diff, so a new occurrence is reported even when that value exists
 * elsewhere in the repository.  Domain/status palettes are documented in
 * docs/THEME_COLOR_ALLOWLIST.md and are not structural palette values.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const STRUCTURAL_LITERALS = new Set([
  "#0f1114", "#0b0d10", "#0a0c0f", "#1a1d23", "#262a33", "#14171c",
  "#161a20", "#1e1e1e", "#e6e1cf", "#8a8d94", "#6c7380", "#5ccfe6",
  "#2d5a8c", "#3e4451", "#6bd968", "#ffb454", "#f28779",
]);

const FEATURE_PATH = /^(src\/(components|features|windows)\/.*\.(css|tsx))$/;
const COLOR = /#[0-9a-fA-F]{3,8}\b/g;

export function findingsForText(file, text, startLine = 1) {
  if (!FEATURE_PATH.test(file) || /\.test\.tsx?$/.test(file)) return [];
  const findings = [];
  for (const [offset, line] of text.split("\n").entries()) {
    for (const match of line.matchAll(COLOR)) {
      const value = match[0].toLowerCase();
      if (STRUCTURAL_LITERALS.has(value)) {
        findings.push({ file, line: startLine + offset, value });
      }
    }
  }
  return findings;
}

function changedLines(base) {
  const diff = execFileSync(
    "git",
    ["diff", "--no-ext-diff", "--unified=0", base, "--", "src/components", "src/features", "src/windows"],
    { encoding: "utf8" },
  );
  const findings = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      file = raw.slice(6);
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      findings.push(...findingsForText(file, raw.slice(1), line));
      line += 1;
    } else if (!raw.startsWith("-")) {
      line += 1;
    }
  }
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const checkFile = args.indexOf("--check-file");
  const baseIndex = args.indexOf("--base");
  const findings = checkFile >= 0
    ? findingsForText(relative(process.cwd(), resolve(args[checkFile + 1])), readFileSync(args[checkFile + 1], "utf8"))
    : changedLines(baseIndex >= 0 ? args[baseIndex + 1] : (process.env.STRUCTURAL_COLOR_BASE || "origin/main"));
  if (findings.length) {
    console.error("Structural palette literals must use src/theme/themes.css semantic tokens:");
    for (const finding of findings) console.error(`  ${finding.file}:${finding.line} ${finding.value}`);
    process.exitCode = 1;
    return;
  }
  console.log("Structural color guard passed.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
