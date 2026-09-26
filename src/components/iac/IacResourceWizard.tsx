import { useEffect, useState } from "react";
import { iacGenerateTerraform, iacGenerateAnsible, type CodegenResult } from "../../lib/tauri";
import type { AiProposal } from "../../state/iacStudioStore";
import "./IacWizards.css";

const PROVIDERS = ["aws", "azure", "gcp", "cisco", "other"] as const;

/** Join the workspace root and a filename with a single separator. */
function joinPath(root: string, name: string): string {
  return `${root.replace(/\/+$/, "")}/${name}`;
}

export function IacResourceWizard({
  rootPath,
  onProposal,
  onClose,
}: {
  rootPath: string | null;
  onProposal: (p: AiProposal) => void;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState<(typeof PROVIDERS)[number]>("aws");
  const [tool, setTool] = useState<"terraform" | "ansible">("terraform");
  const [resourceType, setResourceType] = useState("");
  const [name, setName] = useState("");
  const [details, setDetails] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canGenerate = !!resourceType.trim() && !!name.trim() && !generating;

  async function runGenerate() {
    if (!canGenerate) return;
    setGenerating(true);
    setError(null);
    const intent =
      `Create a ${provider} ${resourceType.trim()} named "${name.trim()}".` +
      (details.trim() ? ` ${details.trim()}` : "");
    try {
      const gen = tool === "terraform" ? iacGenerateTerraform : iacGenerateAnsible;
      const result: CodegenResult = await gen(intent, rootPath ?? ".", undefined, "");
      if (result.unavailable || !result.code.trim()) {
        setError(
          "Generation unavailable — the AI model returned no usable code. " +
            "Check the LLM provider in Settings.",
        );
        return;
      }
      const ext = tool === "terraform" ? "tf" : "yml";
      const filename = `${name.trim()}.${ext}`;
      onProposal({
        code: result.code,
        filename,
        explanation: result.explanation,
        validation: result.validation,
        target_path: rootPath ? joinPath(rootPath, filename) : filename,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="iac-wizard-overlay" role="dialog" aria-modal="true" aria-label="New Resource" data-testid="iac-resource-wizard">
      <div className="iac-wizard-modal">
        <div className="iac-wizard-title">New Resource</div>
        <div className="iac-wizard-field">
          <label>Tool</label>
          <div className="iac-wizard-checks">
            <label><input type="radio" name="tool" checked={tool === "terraform"} onChange={() => setTool("terraform")} /> Terraform</label>
            <label><input type="radio" name="tool" checked={tool === "ansible"} onChange={() => setTool("ansible")} /> Ansible</label>
          </div>
        </div>
        <div className="iac-wizard-field">
          <label>Provider</label>
          <select data-testid="res-provider" value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
            {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
        <div className="iac-wizard-field">
          <label>Resource type</label>
          <input data-testid="res-type" value={resourceType} placeholder="aws_instance" onChange={(e) => setResourceType(e.target.value)} />
        </div>
        <div className="iac-wizard-field">
          <label>Name</label>
          <input data-testid="res-name" value={name} placeholder="web_server" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="iac-wizard-field">
          <label>Details</label>
          <textarea data-testid="res-details" rows={3} value={details} placeholder="t3.micro in the prod VPC" onChange={(e) => setDetails(e.target.value)} />
        </div>
        {error && <div className="iac-wizard-error" data-testid="res-error">{error}</div>}
        <div className="iac-wizard-actions">
          <button className="iac-wizard-cancel" onClick={onClose} data-testid="res-cancel">Cancel</button>
          <button className="iac-wizard-generate" onClick={runGenerate} disabled={!canGenerate} data-testid="res-generate">
            {generating ? "Generating…" : "Generate ▸ diff"}
          </button>
        </div>
      </div>
    </div>
  );
}
