import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string) {
  return readFileSync(join(process.cwd(), file), "utf8");
}

describe("feature-area theme migration", () => {
  it("routes every Task 5 feature batch through semantic structural tokens", () => {
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
      expect(source(file), file).toMatch(/var\(--(?:surface|text|border|accent|status|focus|app-canvas)/);
    }
  });

  it("preserves named topology and troubleshooting domain states", () => {
    expect(source("src/components/topology/TopologyTab.tsx")).toContain("#0ea770");
    expect(source("src/features/troubleshoot/PlaybookPicker.css")).toContain("#d2675a");
  });
});
