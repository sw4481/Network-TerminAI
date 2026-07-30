import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const created: string[] = [];
const guard = join(process.cwd(), "scripts/check-structural-colors.mjs");

function fixture(
  source: string,
  allowlist = { entries: [] },
  filename = "GuardFixture.tsx",
) {
  const directory = mkdtempSync(join(process.cwd(), "src/components/.color-guard-"));
  created.push(directory);
  const file = join(directory, filename);
  const allowlistFile = join(directory, "allowlist.json");
  writeFileSync(file, source);
  writeFileSync(allowlistFile, JSON.stringify(allowlist));
  return { file, allowlistFile, logicalFile: relative(process.cwd(), file) };
}

function check(file: string, allowlistFile: string) {
  return () => execFileSync("node", [guard, "--check-file", file, "--allowlist", allowlistFile], {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
}

function repoFixture() {
  const directory = mkdtempSync(join(tmpdir(), "terminai-color-guard-"));
  created.push(directory);
  mkdirSync(join(directory, "src/components"), { recursive: true });
  const allowlistFile = join(directory, "allowlist.json");
  writeFileSync(allowlistFile, '{"entries":[]}');
  git(directory, "init", "-b", "main");
  git(directory, "config", "user.email", "guard@example.test");
  git(directory, "config", "user.name", "Color Guard");
  writeFileSync(join(directory, "README.md"), "base\n");
  git(directory, "add", ".");
  git(directory, "commit", "-m", "base");
  return { directory, allowlistFile };
}

function runGuard(cwd: string, allowlistFile: string, ...args: string[]) {
  return () => execFileSync("node", [guard, ...args, "--allowlist", allowlistFile], {
    cwd,
    encoding: "utf8",
    stdio: "pipe",
  });
}

afterEach(() => {
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

describe("structural color guard", () => {
  it("rejects arbitrary CSS/TSX literals with file, line, property, and value", () => {
    const f = fixture('const style = { background: "#123456" };\n');
    expect(check(f.file, f.allowlistFile)).toThrow(/GuardFixture\.tsx:1 #123456 property=background/);
  });

  it.each([
    ["named", "const style = { backgroundColor: 'white' };", /white property=backgroundColor/],
    ["quoted property", "const style = { 'color': 'red' };", /red property=color/],
    ["hwb", "const style = { backgroundColor: 'hwb(120 0% 0%)' };", /hwb\(120 0% 0%\) property=backgroundColor/],
    ["lab", "const style = { color: 'lab(50% 20 30)' };", /lab\(50% 20 30\) property=color/],
    ["lch", "const style = { color: 'lch(50% 20 30)' };", /lch\(50% 20 30\) property=color/],
    ["oklab", "const style = { color: 'oklab(50% .1 .1)' };", /oklab\(50% \.1 \.1\) property=color/],
    ["oklch", "const style = { color: 'oklch(50% .1 30)' };", /oklch\(50% \.1 30\) property=color/],
    ["color", "const style = { color: 'color(display-p3 1 0 0)' };", /color\(display-p3 1 0 0\) property=color/],
    ["literal color-mix", ".x { color: color-mix(in srgb, red 20%, #123456); }", /color-mix\(in srgb, red 20%, #123456\) property=color/],
  ])("rejects %s structural color syntax", (_kind, source, expected) => {
    const f = fixture(`${source}\n`);
    expect(check(f.file, f.allowlistFile)).toThrow(expected);
  });

  it.each([
    [
      "linear",
      `.x {
  background: linear-gradient(
    var(--surface-1),
    red 50%
  );
}
`,
      /GuardFixture\.css:4 red property=background/,
    ],
    [
      "radial",
      `.x {
  background-image: radial-gradient(
    var(--surface-1),
    #123456 80%
  );
}
`,
      /GuardFixture\.css:4 #123456 property=background-image/,
    ],
  ])("rejects a disallowed %s-gradient stop after the first comma", (_kind, source, expected) => {
    const f = fixture(source, { entries: [] }, "GuardFixture.css");
    expect(check(f.file, f.allowlistFile)).toThrow(expected);
  });

  it("rejects a multiline color-mix containing a multiline modern literal", () => {
    const f = fixture(`.x {
  color: color-mix(
    in srgb,
    var(--text-primary) 70%,
    lab(
      50% 20 30
    )
  );
}
`, { entries: [] }, "GuardFixture.css");
    expect(check(f.file, f.allowlistFile)).toThrow(
      /GuardFixture\.css:6 color-mix\([\s\S]*property=color/,
    );
  });

  it.each([
    [
      "CSS block",
      `/* .fake { color: red; background: #123456; } */
.x { color: var(--text-primary); }
`,
      "GuardFixture.css",
    ],
    [
      "TSX line",
      `const icon = "🎨"; // const fake = { color: "red", background: "#123456" };
const style = { color: "var(--text-primary)" };
`,
      "GuardFixture.tsx",
    ],
    [
      "JSX block",
      `{/* <div style={{ color: "red", background: "#123456" }} /> */}
const style = { color: "var(--text-primary)" };
`,
      "GuardFixture.tsx",
    ],
  ])("ignores color-like text in %s comments", (_kind, source, filename) => {
    const f = fixture(source, { entries: [] }, filename);
    expect(check(f.file, f.allowlistFile)).not.toThrow();
  });

  it.each([
    [
      "CSS block",
      `/* .fake { color: red; } */ .real {
  color: #123456;
}
`,
      "GuardFixture.css",
      /GuardFixture\.css:2 #123456 property=color/,
    ],
    [
      "TSX line",
      `// const fake = { color: "red" };
const real = { color: "#123456" };
`,
      "GuardFixture.tsx",
      /GuardFixture\.tsx:2 #123456 property=color/,
    ],
  ])("keeps scanning real code after a %s comment", (_kind, source, filename, expected) => {
    const f = fixture(source, { entries: [] }, filename);
    expect(check(f.file, f.allowlistFile)).toThrow(expected);
  });

  it("ignores URLs and strings that merely contain declaration-like color text", () => {
    const f = fixture(`
const documentation = "color: red; background: #123456";
const endpoint = "https://example.test/red/#123456";
const style = { backgroundImage: "url('https://example.test/red/#123456.png')" };
`);
    expect(check(f.file, f.allowlistFile)).not.toThrow();
  });

  it.each([
    ".x { color: transparent; }",
    ".x { color: currentColor; }",
    ".x { color: var(--text-primary); }",
    ".x { color: color-mix(in srgb, var(--status-danger) 15%, transparent); }",
  ])("accepts semantic/non-literal color expression: %s", (source) => {
    const f = fixture(`${source}\n`);
    expect(check(f.file, f.allowlistFile)).not.toThrow();
  });

  it("accepts only an exact machine-readable topology domain entry", () => {
    const pending = fixture('const topologyLink = { stroke: "#d4a857" }; // topology-link\n');
    writeFileSync(pending.allowlistFile, JSON.stringify({ entries: [{
      path: pending.logicalFile,
      value: "#d4a857",
      property: "stroke",
      context: "topology-link",
      role: "topology link health",
    }] }));
    expect(check(pending.file, pending.allowlistFile)).not.toThrow();
  });

  it("rejects an approved domain value when it is misused as structural chrome", () => {
    const pending = fixture('const topologyLink = { background: "#d4a857" }; // topology-link\n');
    writeFileSync(pending.allowlistFile, JSON.stringify({ entries: [{
      path: pending.logicalFile,
      value: "#d4a857",
      property: "stroke",
      context: "topology-link",
      role: "topology link health",
    }] }));
    expect(check(pending.file, pending.allowlistFile)).toThrow(/property=background/);
  });

  it("includes untracked source files when the requested base resolves to HEAD", () => {
    const f = fixture('const style = { color: "#123456" };\n');
    expect(() => execFileSync("node", [guard, "--base", "HEAD"], {
      encoding: "utf8",
      stdio: "pipe",
    })).toThrow(new RegExp(`${f.logicalFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:1 #123456`));
  });

  it("checks an added later line using its complete tracked declaration", () => {
    const { directory, allowlistFile } = repoFixture();
    const gradient = join(directory, "src/components/Gradient.css");
    writeFileSync(gradient, `.x {
  background: linear-gradient(
    var(--surface-1),
    var(--surface-2)
  );
}
`);
    git(directory, "add", ".");
    git(directory, "commit", "-m", "semantic gradient");
    writeFileSync(gradient, `.x {
  background: linear-gradient(
    var(--surface-1),
    var(--surface-2),
    red
  );
}
`);
    expect(runGuard(directory, allowlistFile, "--base", "HEAD")).toThrow(
      /Gradient\.css:5 red property=background/,
    );
  });

  it("uses a real diverged merge-base and checks staged, unstaged, and untracked files", () => {
    const { directory, allowlistFile } = repoFixture();
    git(directory, "switch", "-c", "feature");
    writeFileSync(join(directory, "feature.txt"), "feature\n");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "feature");
    git(directory, "switch", "main");
    writeFileSync(join(directory, "main.txt"), "main\n");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "main");
    git(directory, "switch", "feature");

    writeFileSync(join(directory, "src/components/Staged.css"), ".x { color: red; }\n");
    git(directory, "add", "src/components/Staged.css");
    writeFileSync(join(directory, "src/components/Unstaged.tsx"), "const x = { color: 'oklch(50% .1 30)' };\n");
    git(directory, "add", "src/components/Unstaged.tsx");
    git(directory, "commit", "-m", "tracked");
    writeFileSync(join(directory, "src/components/Unstaged.tsx"), "const x = { color: 'blue' };\n");
    writeFileSync(join(directory, "src/components/StagedOnly.css"), ".x { color: orange; }\n");
    git(directory, "add", "src/components/StagedOnly.css");
    writeFileSync(join(directory, "src/components/Untracked.css"), ".x { color: #123456; }\n");

    expect(runGuard(directory, allowlistFile, "--base", "main")).toThrow(
      /Staged\.css[\s\S]*StagedOnly\.css[\s\S]*Unstaged\.tsx[\s\S]*Untracked\.css/,
    );
  });

  it("treats a tag-push all-zero explicit base as unresolved and falls back safely", () => {
    const { directory, allowlistFile } = repoFixture();
    writeFileSync(join(directory, "src/components/New.css"), ".x { color: red; }\n");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "new color");
    expect(runGuard(
      directory,
      allowlistFile,
      "--base",
      "0000000000000000000000000000000000000000",
    )).toThrow(/New\.css:1 red property=color/);
  });
});
