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
    [
      "escaped protocol slashes",
      String.raw`const re = /https?:\/\//; const style = { color: "#123456" };`,
    ],
    [
      "comment-like character class",
      String.raw`const re = /[/*][^/]*\/\/value/gi; const style = { color: "#123456" };`,
    ],
  ])("keeps scanning real style code after regex %s", (_kind, source) => {
    const f = fixture(`${source}\n`);
    expect(check(f.file, f.allowlistFile)).toThrow(
      /GuardFixture\.tsx:1 #123456 property=color/,
    );
  });

  it("does not scan declaration-like text inside a regex and preserves division comments", () => {
    const regex = fixture(String.raw`const re = /{color:red}[/*]/;
const style = { color: "var(--text-primary)" };
`);
    expect(check(regex.file, regex.allowlistFile)).not.toThrow();

    const division = fixture(`const ratio = total / count; // color: red
const style = { color: "#123456" };
`);
    expect(check(division.file, division.allowlistFile)).toThrow(
      /GuardFixture\.tsx:2 #123456 property=color/,
    );
  });

  it("recognizes regex expressions after control-condition closing parentheses", () => {
    const commentLike = fixture(String.raw`if (ok) /{color:red}[/*]/.test(value);
const style = { color: "var(--text-primary)" };
`);
    expect(check(commentLike.file, commentLike.allowlistFile)).not.toThrow();

    const nested = fixture(String.raw`if ((ok && fn(value))) /https?:\/\//.test(value);
const style = { color: "#123456" };
`);
    expect(check(nested.file, nested.allowlistFile)).toThrow(
      /GuardFixture\.tsx:2 #123456 property=color/,
    );
  });

  it.each([
    ["if", String.raw`if (ok) /{color:red}[/*]/.test(value);`],
    ["while", String.raw`while (ok) /{color:red}[/*]/.test(value);`],
    ["for", String.raw`for (; ok;) /{color:red}[/*]/.test(value);`],
    ["with", String.raw`with (scope) /{color:red}[/*]/.test(value);`],
    ["switch", String.raw`switch (value) { default: /{color:red}[/*]/.test(value); }`],
    ["catch", String.raw`try { work(); } catch (error) { /{color:red}[/*]/.test(value); }`],
  ])("keeps regex semantics in a genuine %s statement", (_keyword, statement) => {
    const f = fixture(`${statement}
const style = { color: "var(--text-primary)" };
`);
    expect(check(f.file, f.allowlistFile)).not.toThrow();
  });

  it("does not treat division after an ordinary call as a regex", () => {
    const f = fixture(`const ratio = fn() / divisor; // color: red
const style = { color: "#123456" };
`);
    expect(check(f.file, f.allowlistFile)).toThrow(
      /GuardFixture\.tsx:2 #123456 property=color/,
    );
  });

  it.each([
    ["member", `const ratio = obj.if(x) / ({ color: "#123456" }).value / divisor;`],
    ["optional member", `const ratio = obj?.while(x) / ({ color: "#123456" }).value / divisor;`],
  ])("does not treat division after a %s call named like a control keyword as a regex", (_kind, source) => {
    const f = fixture(`${source}\n`);
    expect(check(f.file, f.allowlistFile)).toThrow(
      /GuardFixture\.tsx:1 #123456 property=color/,
    );
  });

  it.each([
    [
      "hex",
      `statusDiv.style.cssText = "position: fixed; background: #123456; color: var(--text-primary)";`,
      /GuardFixture\.tsx:1 #123456 property=background/,
    ],
    [
      "named",
      `statusDiv.style.cssText = "position: fixed; color: red";`,
      /GuardFixture\.tsx:1 red property=color/,
    ],
    [
      "modern",
      `statusDiv.style.cssText = "position: fixed; color: hwb(120 0% 0%)";`,
      /GuardFixture\.tsx:1 hwb\(120 0% 0%\) property=color/,
    ],
    [
      "setAttribute style",
      `statusDiv.setAttribute("style", "position: fixed; background: #123456");`,
      /GuardFixture\.tsx:1 #123456 property=background/,
    ],
  ])("scans %s literals in a CSS-bearing TSX string", (_kind, source, expected) => {
    const f = fixture(`${source}\n`);
    expect(check(f.file, f.allowlistFile)).toThrow(expected);
  });

  it("scans a multiline cssText template matching the production pattern", () => {
    const f = fixture(`const statusDiv = document.createElement("div");
statusDiv.style.cssText = \`
  position: fixed;
  background: var(--surface-2);
  border: 1px solid #123456;
  color: color-mix(
    in srgb,
    var(--text-primary),
    lab(50% 20 30)
  );
\`;
`);
    expect(check(f.file, f.allowlistFile)).toThrow(
      /GuardFixture\.tsx:5 #123456 property=border/,
    );
    expect(check(f.file, f.allowlistFile)).toThrow(
      /GuardFixture\.tsx:9 color-mix\([\s\S]*property=color/,
    );
  });

  it("masks cssText template interpolations but keeps scanning CSS after them", () => {
    const semantic = fixture(`statusDiv.style.cssText = \`
  background: \${surface};
  color: rgb(\${channel} 0 0 / \${alpha});
  border-color: var(--border-default);
\`;
`);
    expect(check(semantic.file, semantic.allowlistFile)).not.toThrow();

    const literal = fixture(`statusDiv.style.cssText = \`
  background: \${surface};
  color: red;
\`;
`);
    expect(check(literal.file, literal.allowlistFile)).toThrow(
      /GuardFixture\.tsx:3 red property=color/,
    );
  });

  it("reports each literal color branch in a multiline cssText interpolation", () => {
    const f = fixture(`statusDiv.style.cssText = \`
  color: \${condition
    ? "red"
    : "blue"};
\`;
`);
    expect(check(f.file, f.allowlistFile)).toThrow(
      /GuardFixture\.tsx:3 red property=color/,
    );
    expect(check(f.file, f.allowlistFile)).toThrow(
      /GuardFixture\.tsx:4 blue property=color/,
    );
  });

  it("reports exact nested interpolation colors without flagging escaped prose", () => {
    const f = fixture(`statusDiv.setAttribute("style", \`
  background-color: \${nested
    ? "#123456"
    : choose ? "hwb(120 0% 0%)" : "say \\"red\\" here"};
\`);
`);
    expect(check(f.file, f.allowlistFile)).toThrow(
      /GuardFixture\.tsx:3 #123456 property=background-color/,
    );
    expect(check(f.file, f.allowlistFile)).toThrow(
      /GuardFixture\.tsx:4 hwb\(120 0% 0%\) property=background-color/,
    );
    writeFileSync(f.allowlistFile, JSON.stringify({ entries: [
      {
        path: f.logicalFile,
        value: "#123456",
        property: "background-color",
        context: '"#123456"',
        role: "test nested interpolation hex",
      },
      {
        path: f.logicalFile,
        value: "hwb(120 0% 0%)",
        property: "background-color",
        context: '"hwb(120 0% 0%)"',
        role: "test nested interpolation modern color",
      },
    ] }));
    expect(check(f.file, f.allowlistFile)).not.toThrow();
  });

  it("ignores interpolation identifiers and unrelated prose", () => {
    const f = fixture(`statusDiv.style.cssText = \`
  color: \${redVariable};
  background: \${condition ? "alert red text" : palette.blue};
\`;
`);
    expect(check(f.file, f.allowlistFile)).not.toThrow();
  });

  it("honors escaped CSS url terminators and still scans after the true close", () => {
    const semantic = fixture(String.raw`.x {
  background: url(https://example.test/foo\)red#123456.png);
  color: var(--text-primary);
}
`, { entries: [] }, "GuardFixture.css");
    expect(check(semantic.file, semantic.allowlistFile)).not.toThrow();

    const literal = fixture(String.raw`.x {
  background: url(https://example.test/foo\)red#123456.png);
  color: #abcdef;
}
`, { entries: [] }, "GuardFixture.css");
    expect(check(literal.file, literal.allowlistFile)).toThrow(
      /GuardFixture\.css:3 #abcdef property=color/,
    );
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
