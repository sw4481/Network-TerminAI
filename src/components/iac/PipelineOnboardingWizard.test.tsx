import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const listDirectory = vi.fn();
const generatePipeline = vi.fn();
const generateTerraform = vi.fn();
const generateAnsible = vi.fn();
const gitInit = vi.fn();
const gitCommitPaths = vi.fn();
const gitGetRemote = vi.fn();
const gitSetRemote = vi.fn();
const gitPush = vi.fn();
vi.mock("../../lib/tauri", () => ({
  editorListDirectory: (...a: unknown[]) => listDirectory(...a),
  iacGeneratePipeline: (...a: unknown[]) => generatePipeline(...a),
  iacGenerateTerraform: (...a: unknown[]) => generateTerraform(...a),
  iacGenerateAnsible: (...a: unknown[]) => generateAnsible(...a),
  gitInit: (...a: unknown[]) => gitInit(...a),
  gitCommitPaths: (...a: unknown[]) => gitCommitPaths(...a),
  gitGetRemote: (...a: unknown[]) => gitGetRemote(...a),
  gitSetRemote: (...a: unknown[]) => gitSetRemote(...a),
  gitPush: (...a: unknown[]) => gitPush(...a),
}));

import { PipelineOnboardingWizard } from "./PipelineOnboardingWizard";

function codegen(code: string) {
  return {
    tool: "pipeline",
    code,
    filename: "f.yml",
    explanation: "",
    estimated_apply_time_seconds: 5,
    validation: { valid: null, skipped: true, error: null },
    unavailable: false,
  };
}

function ok() {
  return { ok: true, stdout: "", stderr: "" };
}

function fileNode(name: string, node_type: "file" | "directory" = "file") {
  return { path: `/root/${name}`, name, node_type };
}

function renderWizard(rootPath: string | null = "/root") {
  const onScaffoldProposals = vi.fn();
  const onPipelineProposal = vi.fn();
  const onClose = vi.fn();
  const view = render(
    <PipelineOnboardingWizard
      rootPath={rootPath}
      onScaffoldProposals={onScaffoldProposals}
      onPipelineProposal={onPipelineProposal}
      onClose={onClose}
    />,
  );
  const setHidden = (hidden: boolean) =>
    view.rerender(
      <PipelineOnboardingWizard
        rootPath={rootPath}
        hidden={hidden}
        onScaffoldProposals={onScaffoldProposals}
        onPipelineProposal={onPipelineProposal}
        onClose={onClose}
      />,
    );
  return { onScaffoldProposals, onPipelineProposal, onClose, setHidden };
}

/** concept (1) → target (2). */
function toTargetStep() {
  fireEvent.click(screen.getByTestId("onboarding-next"));
}
/** target (2) → scan (3), optionally selecting a target first. */
function toScanStep(target?: string) {
  toTargetStep();
  if (target) fireEvent.click(screen.getByTestId(`ob-target-${target}`).querySelector("input")!);
  fireEvent.click(screen.getByTestId("onboarding-next"));
}

describe("PipelineOnboardingWizard", () => {
  beforeEach(() => {
    listDirectory.mockReset();
    generatePipeline.mockReset();
    generateTerraform.mockReset();
    generateAnsible.mockReset();
    gitInit.mockReset().mockResolvedValue(ok());
    gitCommitPaths.mockReset().mockResolvedValue(ok());
    gitGetRemote.mockReset().mockResolvedValue(null);
    gitSetRemote.mockReset().mockResolvedValue(ok());
    gitPush.mockReset().mockResolvedValue(ok());
  });

  it("starts on the concept step and explains the 3-part model (6-step flow)", () => {
    listDirectory.mockResolvedValue([]);
    renderWizard();
    expect(screen.getByTestId("onboarding-step-1")).toBeTruthy();
    expect(screen.getByText(/Step 1 of 6/)).toBeTruthy();
    expect(screen.getByTestId("onboarding-model")).toBeTruthy();
  });

  it("step 2 offers all four targets including no-cloud options", () => {
    listDirectory.mockResolvedValue([]);
    renderWizard();
    toTargetStep();
    expect(screen.getByTestId("ob-target-local")).toBeTruthy();
    expect(screen.getByTestId("ob-target-network")).toBeTruthy();
    expect(screen.getByTestId("ob-target-virt")).toBeTruthy();
    expect(screen.getByTestId("ob-target-fabric")).toBeTruthy();
  });

  it("shows the Ansible local-vs-pipeline note only for the network target", () => {
    listDirectory.mockResolvedValue([]);
    renderWizard();
    toTargetStep();
    expect(screen.queryByTestId("ob-ansible-note")).toBeNull();
    fireEvent.click(screen.getByTestId("ob-target-network").querySelector("input")!);
    expect(screen.getByTestId("ob-ansible-note")).toBeTruthy();
  });

  it("auto-passes the scan step when the workspace already has matching files", async () => {
    listDirectory.mockResolvedValue([fileNode("main.tf"), fileNode("vars.tf")]);
    renderWizard();
    toScanStep(); // default target = local (terraform)
    await waitFor(() => expect(screen.getByTestId("onboarding-scan-ok")).toBeTruthy());
    expect(screen.getByTestId("onboarding-scan-ok").textContent).toMatch(/Found 2 Terraform files/);
  });

  it("scans for .yml files when the Ansible network target is chosen", async () => {
    listDirectory.mockResolvedValue([fileNode("playbook.yml")]);
    renderWizard();
    toScanStep("network");
    await waitFor(() => expect(screen.getByTestId("onboarding-scan-ok")).toBeTruthy());
    expect(screen.getByTestId("onboarding-scan-ok").textContent).toMatch(/Found 1 Ansible file/);
  });

  it("scaffolds a single Terraform main.tf for the local target", async () => {
    listDirectory.mockResolvedValue([]);
    generateTerraform.mockResolvedValue(codegen('resource "local_file" "x" {}'));
    const props = renderWizard();
    toScanStep();
    await waitFor(() => expect(screen.getByTestId("onboarding-scaffold")).toBeTruthy());
    fireEvent.click(screen.getByTestId("onboarding-scaffold"));

    await waitFor(() => expect(props.onScaffoldProposals).toHaveBeenCalled());
    const proposals = props.onScaffoldProposals.mock.calls[0][0];
    expect(proposals).toHaveLength(1);
    expect(proposals[0].target_path).toBe("/root/main.tf");
    await waitFor(() => expect(screen.getByTestId("onboarding-step-4")).toBeTruthy());
  });

  it("scaffolds BOTH a playbook and an inventory from STATIC templates (no LLM) for the network target", async () => {
    listDirectory.mockResolvedValue([]);
    const props = renderWizard();
    toScanStep("network");
    await waitFor(() => expect(screen.getByTestId("onboarding-scaffold")).toBeTruthy());
    fireEvent.click(screen.getByTestId("onboarding-scaffold"));

    await waitFor(() => expect(props.onScaffoldProposals).toHaveBeenCalled());
    // Static templates — the LLM is NOT called (that was the source of the
    // misindented-YAML parse error).
    expect(generateAnsible).not.toHaveBeenCalled();
    expect(generateTerraform).not.toHaveBeenCalled();
    const proposals = props.onScaffoldProposals.mock.calls[0][0];
    const paths = proposals.map((p: { target_path: string }) => p.target_path);
    expect(paths).toContain("/root/playbook.yml");
    expect(paths).toContain("/root/inventory.ini");
    // The playbook must be valid, parseable YAML (starts with the doc marker,
    // config example commented out).
    const playbook = proposals.find((p: { filename: string }) => p.filename === "playbook.yml");
    expect(playbook.code).toMatch(/^---/);
    // Commented out with no space after '#' so uncommenting yields correctly
    // indented YAML (the '# - name:' form left a stray leading space).
    expect(playbook.code).toMatch(/#- name: Configure device/);
  });

  it("preserves step state while hidden and does not reset to step 1", async () => {
    listDirectory.mockResolvedValue([]);
    generateTerraform.mockResolvedValue(codegen('resource "local_file" "x" {}'));
    const { setHidden } = renderWizard();
    toScanStep();
    await waitFor(() => expect(screen.getByTestId("onboarding-scaffold")).toBeTruthy());
    fireEvent.click(screen.getByTestId("onboarding-scaffold"));
    await waitFor(() => expect(screen.getByTestId("onboarding-step-4")).toBeTruthy());

    setHidden(true);
    expect(screen.getByTestId("pipeline-onboarding-wizard").style.display).toBe("none");
    setHidden(false);
    expect(screen.getByTestId("onboarding-step-4")).toBeTruthy();
    expect(screen.queryByTestId("onboarding-step-1")).toBeNull();
  });

  it("shows a self-hosted runner setup guide when self-hosted is chosen", async () => {
    listDirectory.mockResolvedValue([fileNode("main.tf")]);
    renderWizard();
    toScanStep();
    await waitFor(() => expect(screen.getByTestId("onboarding-scan-ok")).toBeTruthy());
    fireEvent.click(screen.getByTestId("onboarding-next")); // → step 4
    fireEvent.click(screen.getByTestId("ob-runner-self"));
    expect(screen.getByTestId("ob-runner-guide")).toBeTruthy();
  });

  it("network target generates an ANSIBLE pipeline with a self-hosted runner intent, then reaches step 6", async () => {
    listDirectory.mockResolvedValue([fileNode("playbook.yml")]);
    generatePipeline.mockResolvedValue(codegen("on: pull_request"));
    const props = renderWizard();
    toScanStep("network");
    await waitFor(() => expect(screen.getByTestId("onboarding-scan-ok")).toBeTruthy());
    fireEvent.click(screen.getByTestId("onboarding-next")); // → step 4
    fireEvent.click(screen.getByTestId("onboarding-next")); // → step 5
    fireEvent.click(screen.getByTestId("onboarding-generate"));

    await waitFor(() => expect(props.onPipelineProposal).toHaveBeenCalled());
    const [platform, tool, , , intent] = generatePipeline.mock.calls[0];
    expect(platform).toBe("github");
    expect(tool).toBe("ansible");
    expect(intent).toMatch(/self-hosted/i);
    expect(intent).toMatch(/on-prem|internal/i);
    // advanced to the Next-steps checklist
    await waitFor(() => expect(screen.getByTestId("onboarding-step-6")).toBeTruthy());
  });

  it("network step 6 offers a direct-SSH run-now that dispatches ansible-playbook --check", async () => {
    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("ccie:run-in-terminal", handler);
    try {
      listDirectory.mockResolvedValue([fileNode("playbook.yml")]);
      generatePipeline.mockResolvedValue(codegen("on: pull_request"));
      renderWizard();
      toScanStep("network");
      await waitFor(() => expect(screen.getByTestId("onboarding-scan-ok")).toBeTruthy());
      fireEvent.click(screen.getByTestId("onboarding-next")); // → step 4
      fireEvent.click(screen.getByTestId("onboarding-next")); // → step 5
      fireEvent.click(screen.getByTestId("onboarding-generate"));
      await waitFor(() => expect(screen.getByTestId("onboarding-step-6")).toBeTruthy());

      // The run-now callout is present for the network (direct-SSH) target.
      expect(screen.getByTestId("ob-runnow")).toBeTruthy();
      fireEvent.click(screen.getByTestId("ob-run-check"));
      expect(events).toHaveLength(1);
      expect(events[0].detail.command).toBe(
        "ansible-playbook -i inventory.ini playbook.yml --check",
      );
      expect(events[0].detail.cwd).toBe("/root");
    } finally {
      window.removeEventListener("ccie:run-in-terminal", handler);
    }
  });

  it("does NOT show the direct-SSH run-now section for the local target", async () => {
    listDirectory.mockResolvedValue([fileNode("main.tf")]);
    generatePipeline.mockResolvedValue(codegen("on: pull_request"));
    renderWizard();
    toScanStep(); // local
    await waitFor(() => expect(screen.getByTestId("onboarding-scan-ok")).toBeTruthy());
    fireEvent.click(screen.getByTestId("onboarding-next")); // → step 4
    fireEvent.click(screen.getByTestId("onboarding-next")); // → step 5
    fireEvent.click(screen.getByTestId("onboarding-generate"));
    await waitFor(() => expect(screen.getByTestId("onboarding-step-6")).toBeTruthy());
    expect(screen.queryByTestId("ob-runnow")).toBeNull();
  });

  it("step 6 push runs init → commit → set-remote → push in order", async () => {
    listDirectory.mockResolvedValue([fileNode("main.tf")]);
    generatePipeline.mockResolvedValue(codegen("on: pull_request"));
    renderWizard();
    toScanStep();
    await waitFor(() => expect(screen.getByTestId("onboarding-scan-ok")).toBeTruthy());
    fireEvent.click(screen.getByTestId("onboarding-next")); // → step 4
    fireEvent.click(screen.getByTestId("onboarding-next")); // → step 5
    fireEvent.click(screen.getByTestId("onboarding-generate"));
    await waitFor(() => expect(screen.getByTestId("onboarding-step-6")).toBeTruthy());

    fireEvent.change(screen.getByTestId("ob-remote-url"), {
      target: { value: "git@github.com:me/repo.git" },
    });
    fireEvent.click(screen.getByTestId("onboarding-push"));

    await waitFor(() => expect(gitPush).toHaveBeenCalled());
    expect(gitInit).toHaveBeenCalled();
    expect(gitCommitPaths).toHaveBeenCalled();
    expect(gitSetRemote).toHaveBeenCalledWith("/root", "git@github.com:me/repo.git");
    await waitFor(() =>
      expect(screen.getByTestId("ob-push-status").textContent).toMatch(/Pushed/i),
    );
  });

  it("surfaces a push failure (e.g. auth) verbatim and does not claim success", async () => {
    listDirectory.mockResolvedValue([fileNode("main.tf")]);
    generatePipeline.mockResolvedValue(codegen("on: pull_request"));
    gitPush.mockResolvedValue({ ok: false, stdout: "", stderr: "Permission denied (publickey)" });
    renderWizard();
    toScanStep();
    await waitFor(() => expect(screen.getByTestId("onboarding-scan-ok")).toBeTruthy());
    fireEvent.click(screen.getByTestId("onboarding-next"));
    fireEvent.click(screen.getByTestId("onboarding-next"));
    fireEvent.click(screen.getByTestId("onboarding-generate"));
    await waitFor(() => expect(screen.getByTestId("onboarding-step-6")).toBeTruthy());

    fireEvent.click(screen.getByTestId("onboarding-push"));
    await waitFor(() =>
      expect(screen.getByTestId("ob-push-status").textContent).toMatch(/Permission denied/),
    );
  });

  it("surfaces the honest unavailable message and does NOT hand off a proposal", async () => {
    listDirectory.mockResolvedValue([fileNode("main.tf")]);
    generatePipeline.mockResolvedValue({ ...codegen(""), unavailable: true });
    const props = renderWizard();
    toScanStep();
    await waitFor(() => expect(screen.getByTestId("onboarding-scan-ok")).toBeTruthy());
    fireEvent.click(screen.getByTestId("onboarding-next"));
    fireEvent.click(screen.getByTestId("onboarding-next"));
    fireEvent.click(screen.getByTestId("onboarding-generate"));

    await waitFor(() => expect(screen.getByTestId("onboarding-error")).toBeTruthy());
    expect(screen.getByTestId("onboarding-error").textContent).toMatch(/check the LLM provider/i);
    expect(props.onPipelineProposal).not.toHaveBeenCalled();
  });
});
