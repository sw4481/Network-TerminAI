import { describe, it, expect, vi, beforeEach } from "vitest";

const generatePipeline = vi.fn();
vi.mock("../../lib/tauri", () => ({
  iacGeneratePipeline: (...a: unknown[]) => generatePipeline(...a),
}));

import {
  generatePipelineProposals,
  pipelineTargetPath,
  FLOW_LABEL,
  UNAVAILABLE_MESSAGE,
} from "./pipelineCodegen";

function res(code: string) {
  return {
    tool: "pipeline",
    code,
    filename: "pipeline.yml",
    explanation: "explains it",
    estimated_apply_time_seconds: 5,
    validation: { valid: null, skipped: true, error: null },
    unavailable: false,
  };
}

describe("pipelineTargetPath", () => {
  it("maps github + terraform to .github/workflows/terraform.yml", () => {
    expect(pipelineTargetPath("/root", "github", "terraform")).toBe(
      "/root/.github/workflows/terraform.yml",
    );
  });
  it("maps github + ansible to .github/workflows/ansible.yml", () => {
    expect(pipelineTargetPath("/root", "github", "ansible")).toBe(
      "/root/.github/workflows/ansible.yml",
    );
  });
  it("maps gitlab to a top-level .gitlab-ci.yml regardless of tool", () => {
    expect(pipelineTargetPath("/root", "gitlab", "terraform")).toBe("/root/.gitlab-ci.yml");
  });
  it("returns a relative path when rootPath is null", () => {
    expect(pipelineTargetPath(null, "github", "terraform")).toBe(
      ".github/workflows/terraform.yml",
    );
  });
});

describe("generatePipelineProposals", () => {
  beforeEach(() => generatePipeline.mockReset());

  it("forwards the flow label, auth and beginner intent to the generator", async () => {
    generatePipeline.mockResolvedValueOnce(res("on: pull_request"));
    const out = await generatePipelineProposals("/root", [
      {
        platform: "github",
        tool: "terraform",
        flowLabel: FLOW_LABEL["plan-pr-apply-merge"],
        auth: "AWS via OIDC",
        intent: "beginner context",
      },
    ]);
    expect(out.ok).toBe(true);
    expect(generatePipeline).toHaveBeenCalledWith(
      "github",
      "terraform",
      "plan-on-PR + apply-on-merge",
      "AWS via OIDC",
      "beginner context",
    );
    if (out.ok) {
      expect(out.proposals).toHaveLength(1);
      expect(out.proposals[0].target_path).toBe("/root/.github/workflows/terraform.yml");
      expect(out.proposals[0].filename).toBe("terraform.yml");
    }
  });

  it("passes undefined for blank auth/intent", async () => {
    generatePipeline.mockResolvedValueOnce(res("on: pull_request"));
    await generatePipelineProposals("/root", [
      { platform: "github", tool: "terraform", flowLabel: "x", auth: "  ", intent: "" },
    ]);
    expect(generatePipeline).toHaveBeenCalledWith("github", "terraform", "x", undefined, undefined);
  });

  it("produces one proposal per input in order", async () => {
    generatePipeline
      .mockResolvedValueOnce(res("on: pull_request"))
      .mockResolvedValueOnce(res("stages:"));
    const out = await generatePipelineProposals("/root", [
      { platform: "github", tool: "terraform", flowLabel: "x" },
      { platform: "gitlab", tool: "terraform", flowLabel: "x" },
    ]);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.proposals.map((p) => p.target_path)).toEqual([
        "/root/.github/workflows/terraform.yml",
        "/root/.gitlab-ci.yml",
      ]);
    }
  });

  it("returns the honest unavailable message when the LLM is unavailable", async () => {
    generatePipeline.mockResolvedValueOnce({ ...res(""), unavailable: true });
    const out = await generatePipelineProposals("/root", [
      { platform: "github", tool: "terraform", flowLabel: "x" },
    ]);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.error).toBe(UNAVAILABLE_MESSAGE);
  });

  it("treats empty code as unavailable", async () => {
    generatePipeline.mockResolvedValueOnce(res("   "));
    const out = await generatePipelineProposals("/root", [
      { platform: "github", tool: "terraform", flowLabel: "x" },
    ]);
    expect(out.ok).toBe(false);
  });
});
