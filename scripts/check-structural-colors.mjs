#!/usr/bin/env node
/** Enforce semantic theme tokens for every new source color literal. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE_ROOT = "src";
const DEFAULT_ALLOWLIST = "src/theme/color-literal-allowlist.json";
const COLOR = /#[0-9a-fA-F]{3,8}\b|(?:rgba?|hsla?)\((?!var\()[^)]*\)/g;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

export function isSourceFile(file) {
  return /^src\/.*\.(?:css|tsx)$/.test(file)
    && !/\.test\.tsx?$/.test(file)
    && !(process.env.STRUCTURAL_COLOR_GUARD_IGNORE_TEST_FIXTURES === "1" && file.includes("/.color-guard-"))
    && file !== "src/theme/themes.css";
}

export function propertyFor(line) {
  return line.match(/^\s*([\w-]+)\s*:/)?.[1]
    ?? line.match(/\b(background(?:Color)?|color|border(?:\w+)?|outline|boxShadow|textShadow|fill|stroke)\s*:/)?.[1]
    ?? "unknown";
}

function readAllowlist(file) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  if (!Array.isArray(parsed.entries)) throw new Error(`${file} must contain an entries array`);
  return parsed.entries;
}

function allowed(finding, entries) {
  return entries.some((entry) => entry.path === finding.file
    && entry.value.toLowerCase() === finding.value
    && entry.property === finding.property
    && entry.context
    && finding.source.includes(entry.context)
    && entry.role);
}

export function findingsForText(file, text, entries = []) {
  if (!isSourceFile(file)) return [];
  const findings = [];
  for (const [offset, source] of text.split("\n").entries()) {
    for (const match of source.matchAll(COLOR)) {
      const finding = {
        file,
        line: offset + 1,
        value: match[0].toLowerCase(),
        property: propertyFor(source),
        source,
      };
      if (!allowed(finding, entries)) findings.push(finding);
    }
  }
  return findings;
}

export function resolveBase(requested) {
  const candidates = requested ? [requested] : [
    process.env.STRUCTURAL_COLOR_BASE,
    "origin/main",
    "main",
    "HEAD~1",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return git(["merge-base", candidate, "HEAD"]);
    } catch {
      // A shallow/local checkout may not have origin/main. Try the next base.
    }
  }
  throw new Error("Unable to resolve a structural-color base; pass --base <revision>.");
}

function changedTrackedLines(base, entries) {
  const diff = git(["diff", "--no-ext-diff", "--unified=0", base, "--", SOURCE_ROOT]);
  const findings = [];
  let file = "";
  let line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) { file = raw.slice(6); continue; }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      for (const finding of findingsForText(file, raw.slice(1), entries)) {
        findings.push({ ...finding, line });
      }
      line += 1;
    } else if (!raw.startsWith("-")) line += 1;
  }
  return findings;
}

function untrackedFiles(entries) {
  const findings = [];
  for (const file of git(["ls-files", "--others", "--exclude-standard", "--", SOURCE_ROOT]).split("\n")) {
    if (file && isSourceFile(file)) findings.push(...findingsForText(file, readFileSync(file, "utf8"), entries));
  }
  return findings;
}

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = `${directory}/${entry.name}`;
    if (entry.isDirectory()) walk(file, files);
    else if (isSourceFile(file)) files.push(file);
  }
  return files;
}

export function inventory(entries = []) {
  return walk(SOURCE_ROOT).flatMap((file) => findingsForText(file, readFileSync(file, "utf8"), entries));
}

function printFindings(findings) {
  console.error("Literal colors must be semantic tokens or an exact domain allowlist entry:");
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} ${finding.value} property=${finding.property}`);
  }
}

function main() {
  const args = process.argv.slice(2);
  const get = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const allowlistFile = get("--allowlist") ?? DEFAULT_ALLOWLIST;
  const entries = readAllowlist(allowlistFile);
  const checkFile = args.indexOf("--check-file");
  const findings = checkFile >= 0
    ? findingsForText(relative(process.cwd(), resolve(args[checkFile + 1])), readFileSync(args[checkFile + 1], "utf8"), entries)
    : args.includes("--inventory")
      ? inventory(entries)
      : [...changedTrackedLines(resolveBase(get("--base")), entries), ...untrackedFiles(entries)];
  if (findings.length) {
    printFindings(findings);
    process.exitCode = 1;
  } else {
    console.log(args.includes("--inventory") ? "Structural color inventory passed." : "Structural color guard passed.");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
