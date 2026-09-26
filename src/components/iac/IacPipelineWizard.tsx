import { useEffect, useState } from "react";
import type { AiProposal } from "../../state/iacStudioStore";
import {
  FLOW_LABEL,
  generatePipelineProposals,
  type PipelineFlow,
  type PipelinePlatform,
} from "./pipelineCodegen";
import "./IacWizards.css";

type Platform = PipelinePlatform;
type Flow = PipelineFlow;

export function IacPipelineWizard({
  rootPath,
  detectedTool,
  onProposals,
  onClose,
}: {
  rootPath: string | null;
  detectedTool: "terraform" | "ansible";
  onProposals: (ps: AiProposal[]) => void;
  onClose: () => void;
}) {
  const [github, setGithub] = useState(true);
  const [gitlab, setGitlab] = useState(false);
  const [tool, setTool] = useState<"terraform" | "ansible">(detectedTool);
  const [flow, setFlow] = useState<Flow>("plan-pr-apply-merge");
  const [auth, setAuth] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const platforms: Platform[] = [
    ...(github ? ["github" as const] : []),
    ...(gitlab ? ["gitlab" as const] : []),
  ];
  const canGenerate = platforms.length > 0 && !generating;

  async function runGenerate() {
    if (!canGenerate) return;
    setGenerating(true);
    setError(null);
    try {
      const result = await generatePipelineProposals(
        rootPath,
        platforms.map((p) => ({
          platform: p,
          tool,
          flowLabel: FLOW_LABEL[flow],
          auth: auth.trim() || undefined,
        })),
      );
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onProposals(result.proposals);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  return (
    <div className="iac-wizard-overlay" role="dialog" aria-modal="true" aria-label="New Pipeline" data-testid="iac-pipeline-wizard">
      <div className="iac-wizard-modal">
        <div className="iac-wizard-title">New Pipeline</div>
        <div className="iac-wizard-field">
          <label>Platform</label>
          <div className="iac-wizard-checks">
            <label><input type="checkbox" data-testid="pipe-gh" checked={github} onChange={(e) => setGithub(e.target.checked)} /> GitHub Actions</label>
            <label><input type="checkbox" data-testid="pipe-gl" checked={gitlab} onChange={(e) => setGitlab(e.target.checked)} /> GitLab CI</label>
          </div>
        </div>
        <div className="iac-wizard-field">
          <label>Tool</label>
          <div className="iac-wizard-checks">
            <label><input type="radio" name="ptool" checked={tool === "terraform"} onChange={() => setTool("terraform")} /> Terraform</label>
            <label><input type="radio" name="ptool" checked={tool === "ansible"} onChange={() => setTool("ansible")} /> Ansible</label>
          </div>
        </div>
        <div className="iac-wizard-field">
          <label>Flow</label>
          <select data-testid="pipe-flow" value={flow} onChange={(e) => setFlow(e.target.value as Flow)}>
            <option value="plan-pr-apply-merge">{FLOW_LABEL["plan-pr-apply-merge"]}</option>
            <option value="plan-pr-only">{FLOW_LABEL["plan-pr-only"]}</option>
          </select>
        </div>
        <div className="iac-wizard-field">
          <label>Auth / environment (optional)</label>
          <input data-testid="pipe-auth" value={auth} placeholder="AWS via OIDC, region us-east-1" onChange={(e) => setAuth(e.target.value)} />
        </div>
        {error && <div className="iac-wizard-error" data-testid="pipe-error">{error}</div>}
        <div className="iac-wizard-actions">
          <button className="iac-wizard-cancel" onClick={onClose} data-testid="pipe-cancel">Cancel</button>
          <button className="iac-wizard-generate" onClick={runGenerate} disabled={!canGenerate} data-testid="pipe-generate">
            {generating ? "Generating…" : "Generate ▸ diff"}
          </button>
        </div>
      </div>
    </div>
  );
}
