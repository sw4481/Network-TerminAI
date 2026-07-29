import { iacGeneratePipeline, type CodegenResult } from "../../lib/tauri";
import type { AiProposal } from "../../state/iacStudioStore";

export type PipelinePlatform = "github" | "gitlab";
export type PipelineTool = "terraform" | "ansible";

/** Beginner/power-user flow key → the exact label string the sidecar prompt expects. */
export type PipelineFlow = "plan-pr-apply-merge" | "plan-pr-only";
export const FLOW_LABEL: Record<PipelineFlow, string> = {
  "plan-pr-apply-merge": "plan-on-PR + apply-on-merge",
  "plan-pr-only": "plan-on-PR only",
};

/** Honest "no usable code" message, shared so every entry point reads the same. */
export const UNAVAILABLE_MESSAGE =
  "Generation unavailable — the AI model returned no usable code. " +
  "Check the LLM provider in Settings.";

export interface PipelineGenInput {
  platform: PipelinePlatform;
  tool: PipelineTool;
  /** The FLOW_LABEL string (not the key) — passed straight to the generator. */
  flowLabel: string;
  auth?: string;
  /** Extra beginner-friendly context appended to the generation prompt. */
  intent?: string;
}

export type PipelineGenResult =
  | { ok: true; proposals: AiProposal[] }
  | { ok: false; error: string };

/** Join the workspace root and a relative path with a single separator. */
function joinPath(root: string, rel: string): string {
  return `${root.replace(/\/+$/, "")}/${rel}`;
}

/**
 * Compute the on-disk target path for a generated pipeline file. GitHub
 * Actions live under `.github/workflows/<tool>.yml`; GitLab uses a single
 * top-level `.gitlab-ci.yml`.
 */
export function pipelineTargetPath(
  rootPath: string | null,
  platform: PipelinePlatform,
  tool: PipelineTool,
): string {
  const rel =
    platform === "github"
      ? `.github/workflows/${tool === "terraform" ? "terraform" : "ansible"}.yml`
      : ".gitlab-ci.yml";
  return rootPath ? joinPath(rootPath, rel) : rel;
}

/**
 * Generate one pipeline proposal per input, in order. Any input that returns
 * unavailable/empty code short-circuits the whole batch with the shared honest
 * message — the same behaviour the New Pipeline wizard has always had, now in
 * one place so the onboarding wizard reuses it verbatim.
 *
 * Pipeline files are generic YAML, so they go through the dedicated pipeline
 * generator (validated as YAML, never as terraform HCL / ansible).
 */
export async function generatePipelineProposals(
  rootPath: string | null,
  inputs: PipelineGenInput[],
): Promise<PipelineGenResult> {
  const proposals: AiProposal[] = [];
  for (const input of inputs) {
    const result: CodegenResult = await iacGeneratePipeline(
      input.platform,
      input.tool,
      input.flowLabel,
      input.auth?.trim() || undefined,
      input.intent?.trim() || undefined,
    );
    if (result.unavailable || !result.code.trim()) {
      return { ok: false, error: UNAVAILABLE_MESSAGE };
    }
    const target = pipelineTargetPath(rootPath, input.platform, input.tool);
    proposals.push({
      code: result.code,
      filename: target.split("/").pop() ?? "pipeline.yml",
      explanation: result.explanation,
      validation: result.validation,
      target_path: target,
    });
  }
  return { ok: true, proposals };
}
