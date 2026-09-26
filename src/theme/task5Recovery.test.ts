import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (file: string) => readFileSync(join(root, file), "utf8");

function sourceFiles(directory = join(root, "src")): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(?:css|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("Task 5 theme recovery", () => {
  it("has no malformed token-alpha CSS in stylesheets or inline styles", () => {
    const validRgb = /rgb\(var\(--[\w-]+\)\s*\/\s*(?:0?\.)?\d+\)/g;
    const malformed = /var\(--[\w-]+\)\s*\/\s*(?:0?\.)?\d+\)/;
    const findings = sourceFiles().flatMap((file) =>
      source(file.slice(root.length + 1))
        .split("\n")
        .flatMap((line, index) =>
          malformed.test(line.replace(validRgb, "")) ? [`${file}:${index + 1}`] : []),
    );
    expect(findings).toEqual([]);
    expect(sourceFiles().flatMap((file) =>
      source(file.slice(root.length + 1)).includes("-colorbackground") ? [file] : [],
    )).toEqual([]);
  });

  it("preserves exact Dark editor-tab surface and modal backdrop values", () => {
    const themes = source("src/theme/themes.css");
    expect(themes).toContain("--surface-editor-tab: #252526;");
    expect(themes).toContain("--surface-modal-backdrop-60: rgb(0 0 0 / 60%);");
    expect(source("src/components/editor/EditorTab.css")).toContain(
      "background: var(--surface-editor-tab);",
    );
    expect(source("src/components/RemediationDialog.tsx")).toContain(
      'background: "var(--surface-modal-backdrop-60)"',
    );
  });

  it("keeps Git and debugger states on exact named domain tokens", () => {
    const themes = source("src/theme/themes.css");
    for (const declaration of [
      "--git-added: #98c379;",
      "--git-modified: #e5c07b;",
      "--git-deleted: #e06c75;",
      "--debug-breakpoint: #e06c75;",
      "--debug-current-line: rgb(229 192 123 / 16%);",
    ]) expect(themes).toContain(declaration);

    const git = source("src/components/editor/git-awareness.css");
    expect(git).toContain("background: var(--git-added)");
    expect(git).toContain("background: var(--git-modified)");
    expect(git).toContain("border-left: 6px solid var(--git-deleted)");

    const debug = source("src/components/editor/debug/debug-decorations.css");
    expect(debug).toContain("border: 2px solid var(--debug-breakpoint)");
    expect(debug).toContain("background: var(--debug-current-line)");
  });

  it("keeps success, danger, info, and recording failure treatments distinct", () => {
    const gnmi = source("src/components/settings/GnmiSettingsTab.css");
    expect(gnmi).toMatch(/\.gnmi-status--ok[\s\S]*var\(--status-gnmi-success-surface\)[\s\S]*var\(--status-gnmi-success\)/);
    expect(gnmi).toMatch(/\.gnmi-status--err[\s\S]*var\(--status-gnmi-danger-surface\)[\s\S]*var\(--status-gnmi-danger\)/);
    expect(gnmi).toMatch(/\.gnmi-status--info[\s\S]*var\(--status-gnmi-info-surface\)[\s\S]*var\(--status-gnmi-info\)/);

    const appCss = source("src/App.css");
    expect(appCss).toMatch(/\.status-pill\.running[\s\S]*var\(--tftp-running\)/);
    expect(source("src/App.tsx")).toContain(
      "background:var(--status-recording-failure-surface);border:1px solid var(--status-recording-failure-border)",
    );
    expect(source("src/App.tsx")).toContain("color:var(--status-recording-failure-text)");
  });

  it("preserves representative Dark semantics with documented accessibility adjustments", () => {
    const themes = source("src/theme/themes.css");
    for (const declaration of [
      "--iac-created: #50c878;",
      "--iac-modified: #5298e8;",
      "--iac-destroyed: #f05c4e;",
      "--diff-added-surface: rgb(76 175 80 / 18%);",
      "--diff-removed-surface: rgb(244 67 54 / 18%);",
      "--diff-changed-surface: rgb(255 193 7 / 18%);",
      "--topology-success: #0ea770;",
      "--troubleshoot-running: #d4a14a;",
      "--surface-recording: #0e1116;",
    ]) expect(themes).toContain(declaration);

    expect(source("src/components/Terminal.tsx")).toContain(
      "box-shadow: 0 4px 12px rgb(var(--backdrop-rgb) / 0.5)",
    );
    expect(source("src/components/api/ApiTab.tsx")).toContain(
      'background: "rgb(var(--backdrop-rgb) / 0.6)"',
    );
    expect(source("src/components/netconf/RpcEditor.tsx")).toContain(
      'background: "rgb(var(--backdrop-rgb) / 0.7)"',
    );
    expect(source("src/components/IaCCommandBlock.css")).toContain(
      "color: var(--iac-modified)",
    );
    expect(source("src/components/topology/TopologyTab.tsx")).toContain(
      "border: 1px solid var(--topology-success)",
    );
    expect(source("src/features/troubleshoot/StepNode.css")).toContain(
      "color: var(--troubleshoot-running)",
    );
    expect(source("src/components/vault/VaultTab.css")).toContain(
      "background: rgb(var(--backdrop-rgb) / 0.6)",
    );
    expect(source("src/components/recording/RecordingsTab.css")).toContain(
      "background: var(--surface-recording)",
    );
  });

  it("preserves diff, vendor, and TFTP domain meaning instead of generic surfaces", () => {
    const diff = source("src/components/StructuredDiff.css");
    expect(diff).toContain("background: var(--diff-added-surface)");
    expect(diff).toContain("background: var(--diff-removed-surface)");
    expect(diff).toContain("background: var(--diff-changed-surface)");
    expect(diff).toContain("color: var(--diff-old)");
    expect(diff).toContain("color: var(--diff-new)");

    expect(source("src/components/topology/InlineTopologyPanel.css")).toContain(
      "--neighbor-vendor-color: var(--topology-vendor-default)",
    );

    const app = source("src/App.css");
    expect(app).toMatch(/\.status-pill\.running \{[\s\S]*var\(--tftp-running\)[\s\S]*var\(--tftp-running-border\)[\s\S]*var\(--tftp-running-surface\)/);
    expect(app).toMatch(/\.status-pill\.error,[\s\S]*var\(--tftp-error\)[\s\S]*var\(--tftp-error-border\)[\s\S]*var\(--tftp-error-surface\)/);
  });

  it("keeps common Dark structural roles exact instead of status-flattened", () => {
    expect(source("src/App.css")).toContain(
      "html, body, #root {\n  margin: 0;\n  height: 100%;\n  background: var(--app-canvas);",
    );
    const app = source("src/App.tsx");
    expect(app).toContain('color: "var(--text-muted)" }}>Loading terminal');
    expect(app.match(/background: "var\(--surface-modal-backdrop-60\)"/g)).toHaveLength(3);
    expect(app.match(/background: "var\(--app-canvas\)"/g)?.length).toBeGreaterThanOrEqual(3);

    expect(source("src/components/BlockNotebook.css")).toContain(
      ".notebook-info h3 {\n  margin: 0 0 8px 0;\n  font-size: 16px;\n  font-weight: 500;\n  color: var(--text-primary);",
    );
    const errors = source("src/components/ErrorAnalysis.css");
    expect(errors).toContain(".error-analysis-content {\n  padding: 12px;\n  color: var(--text-primary)");
    expect(errors).toContain(".error-explanation p {\n  margin: 0;\n  color: var(--text-primary)");
    expect(errors).toContain("font-size: 12px;\n  color: var(--text-primary);\n  background: transparent");

    expect(source("src/components/FanoutPanel.css")).toContain(
      "button:hover { background: var(--surface-fanout-action-hover); color: var(--text-primary); }",
    );
    expect(source("src/components/iac/IacWizards.css")).toContain(
      "background: var(--surface-terminal); color: var(--text-primary);",
    );
    expect(source("src/features/troubleshoot/NarrationPanel.css")).toContain(
      "border-color: var(--troubleshoot-attention); color: var(--text-primary);",
    );
    expect(source("src/components/NotificationCenter.css")).toContain(
      "background-color: var(--bg-secondary, var(--surface-terminal));",
    );
    expect(source("src/components/TerminalSettingsTab.css")).toContain(
      "background: var(--bg-secondary, var(--surface-terminal)); color: var(--text-primary, var(--text-inverse)); border: 1px solid var(--focus-control);",
    );

    for (const file of [
      "AciSettingsTab.css",
      "CatalystCenterSettingsTab.css",
      "CmlSettingsTab.css",
      "FmcSettingsTab.css",
      "GitCiSettingsTab.css",
      "GnmiSettingsTab.css",
      "IseSettingsTab.css",
      "MerakiSettingsTab.css",
      "NetclawSettingsTab.css",
      "SplunkSettingsTab.css",
      "StealthwatchSettingsTab.css",
      "ThousandEyesSettingsTab.css",
    ]) {
      expect(source(`src/components/settings/${file}`), file).toContain(
        "color: var(--text-on-strong-accent);",
      );
    }
  });
});
