import { useState } from "react";
import { iacGenerateAnsible, iacGenerateTerraform, type CodegenResult } from "../../lib/tauri";
import { dispatchAskAi } from "../editor/askAi";
import type { AiProposal } from "../../state/iacStudioStore";
import "./IacAiPanel.css";

/** True for CI/CD pipeline YAML (GitLab CI, GitHub Actions) — generic YAML that
 * is NOT an Ansible playbook, so the free-form AI panel must not label it
 * "ansible". These have their own New Pipeline… wizard. */
function isCiPipeline(filePath: string | null): boolean {
  const p = (filePath ?? "").toLowerCase().replace(/\\/g, "/");
  const name = p.split("/").pop() ?? "";
  return name === ".gitlab-ci.yml" || name === ".gitlab-ci.yaml" || p.includes("/.github/workflows/");
}

/** Pick the codegen tool from the active file. Extension wins; language is a
 * fallback. Returns null when the file isn't a recognized free-form codegen
 * target (including CI pipeline files, which use the New Pipeline… wizard). */
function detectTool(filePath: string | null, language: string): "terraform" | "ansible" | null {
  if (isCiPipeline(filePath)) return null;
  const path = (filePath ?? "").toLowerCase();
  if (path.endsWith(".tf") || path.endsWith(".hcl")) return "terraform";
  if (path.endsWith(".yml") || path.endsWith(".yaml")) return "ansible";
  if (language === "hcl" || language === "terraform") return "terraform";
  if (language === "yaml" || language === "ansible") return "ansible";
  return null;
}

export function IacAiPanel({
  tabId,
  rootPath,
  filePath,
  language,
  content,
  generating,
  error,
  onProposal,
  onGenerating,
  onError,
}: {
  tabId: string;
  rootPath: string | null;
  filePath: string | null;
  language: string;
  content: string;
  generating: boolean;
  error: string | null;
  onProposal: (p: AiProposal) => void;
  onGenerating: (g: boolean) => void;
  onError: (msg: string) => void;
}) {
  const [intent, setIntent] = useState("");
  const tool = detectTool(filePath, language);
  const canGenerate = !!filePath && !!tool && !!intent.trim() && !generating;

  async function runGenerate() {
    const effectiveIntent = intent.trim();
    if (!tool || !effectiveIntent) return;
    onGenerating(true);
    try {
      const gen = tool === "terraform" ? iacGenerateTerraform : iacGenerateAnsible;
      const result: CodegenResult = await gen(
        effectiveIntent,
        rootPath ?? ".",
        undefined,
        content,
      );
      if (result.unavailable || !result.code.trim()) {
        onError(
          "Generation unavailable — the AI model returned no usable code. " +
            "Check the LLM provider in Settings.",
        );
        return;
      }
      onProposal({
        code: result.code,
        filename: result.filename,
        explanation: result.explanation,
        validation: result.validation,
      });
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    }
  }

  function runExplain() {
    dispatchAskAi({
      tabId,
      action: "explain",
      selection: content,
      language,
      filePath,
    });
  }

  return (
    <div className="iac-ai-panel" data-testid="iac-ai-panel">
      <div className="iac-ai-header">AI</div>
      <textarea
        className="iac-ai-prompt"
        data-testid="iac-ai-prompt"
        placeholder={
          tool
            ? `Describe the ${tool} change to generate…`
            : isCiPipeline(filePath)
              ? "CI/CD pipeline file — use the IaC menu → New Pipeline… to regenerate"
              : "Open a .tf or .yml file to generate code"
        }
        value={intent}
        onChange={(e) => setIntent(e.target.value)}
        rows={4}
      />
      <div className="iac-ai-actions">
        <button
          data-testid="iac-ai-generate"
          onClick={() => runGenerate()}
          disabled={!canGenerate}
          title="Generate code into a diff preview"
        >
          {generating ? "Generating…" : "Generate"}
        </button>
      </div>
      <div className="iac-ai-actions iac-ai-actions-secondary">
        <button
          data-testid="iac-ai-explain"
          onClick={runExplain}
          disabled={!filePath}
          className="iac-ai-explain"
          title="Ask the agent to explain this file (opens in the agent chat panel)"
        >
          Explain in chat ↗
        </button>
      </div>
      {error && (
        <div className="iac-ai-error" data-testid="iac-ai-error">
          {error}
        </div>
      )}
      <p className="iac-ai-hint">
        Accepting a diff only edits the buffer. Applying changes still requires
        approval.
      </p>
    </div>
  );
}
