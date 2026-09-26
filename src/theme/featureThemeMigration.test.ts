import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function source(file: string) {
  return readFileSync(join(root, file), "utf8").replaceAll("\r\n", "\n");
}

describe("feature-area theme migration", () => {
  it("proves the full source inventory has no residual structural literals", () => {
    expect(() => execFileSync("node", ["scripts/check-structural-colors.mjs", "--inventory"], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, STRUCTURAL_COLOR_GUARD_IGNORE_TEST_FIXTURES: "1" },
    })).not.toThrow();
  });

  it("keeps each Task 5 batch on semantic state tokens", () => {
    for (const file of [
      "src/components/BlockNotebook.css",
      "src/components/api/ApiTab.tsx",
      "src/components/netconf/NetconfTab.tsx",
      "src/components/editor/EditorTab.css",
      "src/components/iac/IacStudioTab.css",
      "src/components/topology/TopologyTab.tsx",
      "src/features/troubleshoot/PlaybookPicker.css",
      "src/components/vault/VaultTab.css",
      "src/components/recording/RecordingsTab.css",
      "src/components/settings/IseSettingsTab.css",
    ]) {
      expect(source(file), file).toMatch(/var\(--(?:surface|text|border|status|focus|app-canvas)/);
    }
    const codeBlock = source("src/components/CodeBlock.css");
    expect(codeBlock).toContain(".code-block-status-executing .code-block-status-icon {\n  color: var(--status-info)");
    expect(codeBlock).toContain("var(--status-success)");
    expect(codeBlock).toContain("var(--status-warning)");
    expect(codeBlock).toContain("var(--status-danger)");
  });
});
