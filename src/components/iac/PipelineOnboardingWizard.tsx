import { useCallback, useEffect, useState } from "react";
import {
  editorListDirectory,
  iacGenerateTerraform,
  gitInit,
  gitCommitPaths,
  gitGetRemote,
  gitSetRemote,
  gitPush,
  type CodegenResult,
  type GitCmdResult,
} from "../../lib/tauri";
import type { AiProposal } from "../../state/iacStudioStore";
import {
  FLOW_LABEL,
  generatePipelineProposals,
  UNAVAILABLE_MESSAGE,
  type PipelineFlow,
  type PipelinePlatform,
  type PipelineTool,
} from "./pipelineCodegen";
import { buildPlaybookCommand, runInTerminal } from "./runPlaybook";
import "./IacWizards.css";
import "./PipelineOnboardingWizard.css";

type Step = 1 | 2 | 3 | 4 | 5 | 6;
type Target = "local" | "network" | "virt" | "fabric";
type RunnerLocation = "self-hosted" | "cloud";

interface TargetDef {
  tool: PipelineTool;
  label: string;
  blurb: string;
  scaffoldIntent: string;
  /** Primary scaffold filename. Network also gets an inventory (see runScaffold). */
  scaffoldFile: string;
  scanExt: RegExp;
  scanNoun: string;
  /** null hides the connection field (nothing remote to reach). */
  connectionLabel: string | null;
  connectionPlaceholder: string;
  pipelineNoun: string;
  defaultRunner: RunnerLocation;
  /** Where the user types the actual device/infra changes — shown in-wizard. */
  deviceEditsHint: string;
}

const TARGETS: Record<Target, TargetDef> = {
  local: {
    tool: "terraform",
    label: "Just learning / local only",
    blurb: "No servers, no cloud. Terraform writes a local file — perfect for learning the pipeline mechanics safely first.",
    scaffoldIntent:
      "Create a minimal, SAFE starter Terraform file for someone brand new to " +
      "Infrastructure-as-Code. Use a single local_file (or null_resource) that " +
      "requires NO cloud credentials or provider login, so it can be planned and " +
      "applied on any machine. Start with a prominent ASCII-box comment header " +
      "(using # characters, like: # ╔══...══╗) explaining this is a learning " +
      "starter, then add ⚠️ emoji comments marking where the user should edit " +
      "values (filename, content). Add friendly comments explaining what each block does.",
    scaffoldFile: "main.tf",
    scanExt: /\.tf$/,
    scanNoun: "Terraform",
    connectionLabel: null,
    connectionPlaceholder: "",
    pipelineNoun: "purely local resources (no remote target, no cloud)",
    defaultRunner: "cloud",
    deviceEditsHint: "Edit main.tf to change what gets created.",
  },
  network: {
    tool: "ansible",
    label: "Network devices (Cisco / Juniper / Arista)",
    blurb: "Ansible pushes config to your devices over SSH/NETCONF. Agentless, on-prem, no cloud. The classic network-automation path.",
    scaffoldIntent:
      "Create a minimal, SAFE starter Ansible playbook for a network engineer new " +
      "to IaC. Start with a prominent ASCII-box comment header (using # ╔══...══╗) " +
      "explaining this is safe to run as-is (read-only facts), then use the " +
      "cisco.ios collection. Show ONE read-only fact-gathering play (ios_facts) " +
      "AND, clearly COMMENTED OUT inside another ASCII box with ⚠️ markers, an " +
      "example cisco.ios.ios_config task with placeholder config lines showing " +
      "exactly where device commands go. Reference an external inventory file. " +
      "Nothing destructive; plain-English comments on every play.",
    scaffoldFile: "playbook.yml",
    scanExt: /\.ya?ml$/,
    scanNoun: "Ansible",
    connectionLabel: "How does CI reach your devices? (optional)",
    connectionPlaceholder: "e.g. SSH to 10.0.0.0/24, credentials from vault",
    pipelineNoun: "network device configuration via Ansible (on-prem, over SSH/NETCONF)",
    defaultRunner: "self-hosted",
    deviceEditsHint:
      "Put device IPs/creds in inventory.ini, and the config you want pushed in the ios_config task in playbook.yml.",
  },
  virt: {
    tool: "terraform",
    label: "On-prem virtualization (Proxmox / VMware)",
    blurb: "Terraform spins up VMs/containers on your own hardware. Your datacenter, not a cloud.",
    scaffoldIntent:
      "Create a minimal starter Terraform file targeting on-prem virtualization " +
      "(Proxmox or VMware vSphere) for someone new to IaC. Start with an ASCII-box " +
      "comment header (# ╔══...══╗), then define ONE small VM/container resource. " +
      "Include the provider block with ⚠️-marked PLACEHOLDER connection values " +
      "(host, API token) the user must fill in. Use ⚠️ EDIT THIS comments to mark " +
      "every field requiring real values. Plain-English comments throughout; never " +
      "include real credentials.",
    scaffoldFile: "main.tf",
    scanExt: /\.tf$/,
    scanNoun: "Terraform",
    connectionLabel: "How does CI reach your hypervisor? (optional)",
    connectionPlaceholder: "e.g. Proxmox API token, host pve.local",
    pipelineNoun: "on-prem VMs/containers via Terraform (Proxmox or vSphere)",
    defaultRunner: "self-hosted",
    deviceEditsHint: "Edit the provider block (host/token) and the VM resource in main.tf.",
  },
  fabric: {
    tool: "terraform",
    label: "Network fabric (ACI / IOS-XE / Juniper)",
    blurb: "Terraform declares fabric/device config as code — Cisco ACI, IOS-XE via RESTCONF, and more. On-prem, no cloud.",
    scaffoldIntent:
      "Create a minimal starter Terraform file for on-prem network fabric (Cisco " +
      "ACI or IOS-XE via RESTCONF) for someone new to IaC. Start with an ASCII-box " +
      "header (# ╔══...══╗), then define ONE small declarative resource (tenant, " +
      "VLAN, or interface description). Include the provider block with ⚠️-marked " +
      "PLACEHOLDER connection values (controller URL/creds) the user must fill in. " +
      "Use ⚠️ EDIT THIS on every field needing real values. Plain-English comments; " +
      "never include real credentials.",
    scaffoldFile: "main.tf",
    scanExt: /\.tf$/,
    scanNoun: "Terraform",
    connectionLabel: "How does CI reach your fabric? (optional)",
    connectionPlaceholder: "e.g. APIC at apic.local, or IOS-XE RESTCONF",
    pipelineNoun: "on-prem network fabric via Terraform (ACI or IOS-XE RESTCONF)",
    defaultRunner: "self-hosted",
    deviceEditsHint: "Edit the provider block (controller URL/creds) and the fabric resource in main.tf.",
  },
};

/** A ready-to-edit Ansible inventory — a static template is more reliable here
 *  than asking the LLM for one, and gives the user an obvious place for device
 *  IPs and credentials. */
const INVENTORY_TEMPLATE = `# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  Ansible Inventory — Edit this file to add your devices                 ║
# ╚══════════════════════════════════════════════════════════════════════════╝
#
# ⚠️  ACTION REQUIRED: Replace the placeholder IPs below with your real devices
#
# For production, keep passwords in Ansible Vault, not here in plain text.

[routers]
# ⬇️ EDIT THESE — Replace with your actual device hostnames/IPs
core-rtr-1      ansible_host=10.0.0.1
core-rtr-2      ansible_host=10.0.0.2

[routers:vars]
ansible_network_os=cisco.ios.ios
ansible_connection=network_cli
ansible_user=admin
# ⚠️ EDIT THIS — Set your username and password (or use ansible-vault)
# ansible_password=  # prefer: ansible-vault, or an env var / CI secret
`;

/** A ready-to-edit starter playbook. Static (not LLM-generated) because a
 *  boilerplate ios_facts starter has no ambiguity — and LLM output regularly
 *  ships subtly misindented YAML that fails to parse. This is guaranteed valid
 *  and shows exactly where device commands go (the commented ios_config task). */
const PLAYBOOK_TEMPLATE = `---
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  Starter Ansible Playbook for Network Devices (Cisco IOS)               ║
# ╚══════════════════════════════════════════════════════════════════════════╝
#
# ✅ SAFE TO RUN: This reads facts only (no changes to devices)
# ⚠️  TO PUSH CONFIG: Uncomment the ios_config task at the bottom

- name: Gather IOS device facts
  hosts: all
  gather_facts: false
  collections:
    - cisco.ios
  vars:
    # Can be overridden in inventory or extra vars.
    ansible_network_os: cisco.ios.ios
  tasks:
    - name: Collect IOS facts
      cisco.ios.ios_facts:
      register: ios_facts_output

    - name: Show a couple of gathered facts
      ansible.builtin.debug:
        msg: "{{ ansible_facts['net_hostname'] }} is running {{ ansible_facts['net_version'] }}"

    # ╔═══════════════════════════════════════════════════════════════════════╗
    # ║  ⬇️ YOUR DEVICE CONFIG GOES HERE ⬇️                                    ║
    # ╚═══════════════════════════════════════════════════════════════════════╝
    # Uncomment the task below (remove the '# ') and edit the config lines
    # to push your changes to devices.
    #
    #- name: Configure device
    #  cisco.ios.ios_config:
    #    lines:
    #      - description Configured by Ansible
    #    parents: interface GigabitEthernet1/0/1
`;

const PIPELINE_INTENT_BASE =
  "This is the user's FIRST pipeline. They are a network engineer new to " +
  "Infrastructure-as-Code. Add generous, beginner-friendly YAML comments above " +
  "each top-level section (triggers, plan job, apply job) explaining it in plain " +
  "English, using the analogy that a pipeline is a MOP that runs itself. Keep it " +
  "minimal and safe.";

function joinPath(root: string, name: string): string {
  return `${root.replace(/\/+$/, "")}/${name}`;
}

/** Compose the pipeline intent from the chosen target + runner + platform. */
function buildPipelineIntent(
  target: Target,
  runner: RunnerLocation,
  platform: PipelinePlatform,
): string {
  const t = TARGETS[target];
  const parts = [PIPELINE_INTENT_BASE, `The pipeline drives ${t.tool} to manage ${t.pipelineNoun}.`];
  if (runner === "self-hosted") {
    parts.push(
      platform === "github"
        ? "Run on a SELF-HOSTED runner: set `runs-on: self-hosted` so jobs execute on the user's own machine that can reach internal devices — do NOT use cloud runners like ubuntu-latest."
        : "Run on a SELF-HOSTED GitLab runner: add `tags: [self-hosted]` to the jobs so they run on the user's own runner, not shared cloud runners.",
    );
  } else {
    parts.push(
      platform === "github"
        ? "Run on a cloud-hosted runner: `runs-on: ubuntu-latest`."
        : "Run on GitLab's shared cloud runners.",
    );
  }
  if (target !== "local") {
    parts.push("This is an internal/on-prem deployment — no public cloud provider (AWS/Azure/GCP) is involved.");
  }
  return parts.join(" ");
}

type WorkspaceScan =
  | { status: "checking" }
  | { status: "has-code"; count: number }
  | { status: "empty" }
  | { status: "error"; message: string };

type PushState =
  | { status: "idle" }
  | { status: "working"; note: string }
  | { status: "done"; note: string }
  | { status: "error"; note: string };

export function PipelineOnboardingWizard({
  rootPath,
  onScaffoldProposals,
  onPipelineProposal,
  onClose,
  hidden = false,
}: {
  rootPath: string | null;
  /** Step-3 starter file(s) — flow through the normal diff → accept → write path.
   *  May be more than one (e.g. playbook + inventory for the network target). */
  onScaffoldProposals: (ps: AiProposal[]) => void;
  /** Final pipeline proposal; parent also arms coach-marks before showing it. */
  onPipelineProposal: (p: AiProposal) => void;
  onClose: () => void;
  /** Kept mounted (state preserved) but visually hidden while a diff preview is
   *  showing over it — so scaffold-then-continue doesn't reset the wizard. */
  hidden?: boolean;
}) {
  const [step, setStep] = useState<Step>(1);
  const [target, setTarget] = useState<Target>("local");
  const [scan, setScan] = useState<WorkspaceScan>({ status: "checking" });
  const [platform, setPlatform] = useState<PipelinePlatform>("github");
  const [flow, setFlow] = useState<PipelineFlow>("plan-pr-apply-merge");
  const [runner, setRunner] = useState<RunnerLocation>("cloud");
  const [connection, setConnection] = useState("");
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 6 (Next steps) git-push flow.
  const [remoteUrl, setRemoteUrl] = useState("");
  const [remoteChecked, setRemoteChecked] = useState(false);
  const [push, setPush] = useState<PushState>({ status: "idle" });

  const targetDef = TARGETS[target];

  useEffect(() => {
    if (hidden) return; // diff preview owns Escape while we're hidden
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, hidden]);

  function chooseTarget(next: Target) {
    setTarget(next);
    setRunner(TARGETS[next].defaultRunner);
    setScan({ status: "checking" });
  }

  const runScan = useCallback(async () => {
    setScan({ status: "checking" });
    try {
      const nodes = await editorListDirectory(rootPath ?? ".");
      const count = nodes.filter(
        (n) => n.node_type === "file" && targetDef.scanExt.test(n.name),
      ).length;
      setScan(count > 0 ? { status: "has-code", count } : { status: "empty" });
    } catch (e) {
      setScan({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [rootPath, targetDef.scanExt]);

  useEffect(() => {
    if (step === 3 && scan.status === "checking") void runScan();
  }, [step, scan.status, runScan]);

  // On reaching step 6, look up whether a remote is already configured.
  const checkRemote = useCallback(async () => {
    try {
      const url = await gitGetRemote(rootPath ?? ".");
      if (url) setRemoteUrl(url);
    } catch {
      /* read-only best-effort */
    } finally {
      setRemoteChecked(true);
    }
  }, [rootPath]);

  useEffect(() => {
    if (step === 6 && !remoteChecked) void checkRemote();
  }, [step, remoteChecked, checkRemote]);

  const mkProposal = useCallback(
    (
      filename: string,
      code: string,
      explanation: string,
      validation: AiProposal["validation"],
    ): AiProposal => ({
      code,
      filename,
      explanation,
      validation,
      target_path: rootPath ? joinPath(rootPath, filename) : filename,
    }),
    [rootPath],
  );

  async function runScaffold() {
    setGenerating(true);
    setError(null);
    try {
      // Network target uses STATIC templates (playbook + inventory), not the
      // LLM: a boilerplate ios_facts starter is unambiguous, and LLM YAML
      // regularly ships subtly misindented output that fails to parse. Static
      // templates are guaranteed valid.
      if (target === "network") {
        onScaffoldProposals([
          mkProposal("playbook.yml", PLAYBOOK_TEMPLATE, "Starter Ansible playbook (read-only ios_facts; commented ios_config example).", {
            valid: null,
            skipped: true,
            error: null,
          }),
          mkProposal("inventory.ini", INVENTORY_TEMPLATE, "Starter Ansible inventory — put device IPs/creds here.", {
            valid: null,
            skipped: true,
            error: null,
          }),
        ]);
        setStep(4);
        return;
      }

      // Terraform targets (local / virt / fabric) still use the generator —
      // HCL from the LLM goes through `terraform fmt` validation, so misindent
      // is caught/corrected there, unlike raw YAML.
      const result: CodegenResult = await iacGenerateTerraform(
        targetDef.scaffoldIntent,
        rootPath ?? ".",
        undefined,
        "",
      );
      if (result.unavailable || !result.code.trim()) {
        setError(UNAVAILABLE_MESSAGE);
        return;
      }
      onScaffoldProposals([
        mkProposal(targetDef.scaffoldFile, result.code, result.explanation, result.validation),
      ]);
      setStep(4);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  async function runGenerate() {
    setGenerating(true);
    setError(null);
    try {
      const result = await generatePipelineProposals(rootPath, [
        {
          platform,
          tool: targetDef.tool,
          flowLabel: FLOW_LABEL[flow],
          auth: connection.trim() || undefined,
          intent: buildPipelineIntent(target, runner, platform),
        },
      ]);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onPipelineProposal(result.proposals[0]);
      // Advance to the Next-steps checklist (the diff shows over us meanwhile).
      setStep(6);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setGenerating(false);
    }
  }

  // Step 6 (network only): run the playbook DIRECTLY over SSH in a terminal —
  // no CI runner needed. --check = dry run (safe), else a real run.
  function runPlaybookDirect(check: boolean) {
    const cmd = buildPlaybookCommand({
      playbook: "playbook.yml",
      inventory: "inventory.ini",
      check,
    });
    runInTerminal(cmd, rootPath);
  }

  // Step 6: init (if needed) → commit everything → set remote → push.
  async function runPush() {
    const cwd = rootPath ?? ".";
    const fail = (r: GitCmdResult, verb: string) =>
      setPush({ status: "error", note: `${verb} failed: ${r.stderr || r.stdout || "unknown error"}` });
    try {
      setPush({ status: "working", note: "Initializing repository…" });
      const init = await gitInit(cwd);
      if (!init.ok) return fail(init, "git init");

      setPush({ status: "working", note: "Committing your files…" });
      const commit = await gitCommitPaths(cwd, [], "Add IaC pipeline via CCIE Terminal");
      if (!commit.ok) return fail(commit, "git commit");

      if (remoteUrl.trim()) {
        setPush({ status: "working", note: "Setting the remote…" });
        const setRemote = await gitSetRemote(cwd, remoteUrl.trim());
        if (!setRemote.ok) return fail(setRemote, "git remote");
      }

      setPush({ status: "working", note: "Pushing to your Git host…" });
      const pushed = await gitPush(cwd);
      if (!pushed.ok) return fail(pushed, "git push");

      setPush({
        status: "done",
        note: "Pushed. Your Git host should now show the pipeline running on your next PR.",
      });
    } catch (e) {
      setPush({ status: "error", note: e instanceof Error ? e.message : String(e) });
    }
  }

  const runnerLabelPlatform = platform === "github" ? "GitHub" : "GitLab";

  return (
    <div
      className="iac-wizard-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Get Started with Pipelines"
      data-testid="pipeline-onboarding-wizard"
      style={hidden ? { display: "none" } : undefined}
    >
      <div className="iac-wizard-modal onboarding-modal">
        <div className="onboarding-header">
          <div className="iac-wizard-title">Get Started with Pipelines</div>
          <div className="onboarding-progress" aria-hidden>
            {[1, 2, 3, 4, 5, 6].map((n) => (
              <span
                key={n}
                className={`onboarding-dot ${n === step ? "active" : ""} ${n < step ? "done" : ""}`}
              />
            ))}
          </div>
          <div className="onboarding-step-label">Step {step} of 6</div>
        </div>

        {/* Step 1 — concept + how the pieces connect */}
        {step === 1 && (
          <div className="onboarding-body" data-testid="onboarding-step-1">
            <p>
              A <strong>pipeline</strong> is like a MOP that runs itself. You commit
              your changes and it does the work — safely, the same way every time.
            </p>
            <ol className="onboarding-flow">
              <li>You open a <strong>Pull Request</strong> with your change</li>
              <li>It runs a <strong>plan</strong> — a dry run showing what would change</li>
              <li>A teammate <strong>reviews</strong> the plan</li>
              <li>On <strong>merge</strong>, it <strong>applies</strong> the change for real</li>
            </ol>
            <div className="onboarding-model" data-testid="onboarding-model">
              <strong>Three pieces have to connect:</strong>
              <ol className="onboarding-flow">
                <li>
                  <strong>The IaC file</strong> — what you actually want done (your
                  device config / resources). You edit this.
                </li>
                <li>
                  <strong>Your Git host</strong> (GitHub/GitLab) — stores the code and
                  triggers the pipeline when you open a PR.
                </li>
                <li>
                  <strong>A runner</strong> — a machine that actually executes the
                  pipeline's steps. Cloud runners can't reach internal gear; a
                  <strong> self-hosted</strong> runner on your network can.
                </li>
              </ol>
              <p className="onboarding-muted">
                This wizard writes the files and helps you push them. You install the
                runner once (we'll show you how). None of this needs a cloud account.
              </p>
            </div>
          </div>
        )}

        {/* Step 2 — choose target */}
        {step === 2 && (
          <div className="onboarding-body" data-testid="onboarding-step-2">
            <p>What do you want this pipeline to manage?</p>
            {(Object.keys(TARGETS) as Target[]).map((key) => (
              <label
                key={key}
                className="onboarding-radio-card"
                data-testid={`ob-target-${key}`}
              >
                <input
                  type="radio"
                  name="ob-target"
                  checked={target === key}
                  onChange={() => chooseTarget(key)}
                />
                <span>
                  <strong>{TARGETS[key].label}</strong>
                  <br />
                  <span className="onboarding-muted">{TARGETS[key].blurb}</span>
                </span>
              </label>
            ))}
            <p className="onboarding-muted">
              Uses <strong>{targetDef.tool === "ansible" ? "Ansible" : "Terraform"}</strong> under the hood.
            </p>
            {target === "network" && (
              <div className="onboarding-note" data-testid="ob-ansible-note">
                <strong>Two ways to run Ansible against devices:</strong>
                <ul>
                  <li>
                    <strong>From here, right now</strong> — <code>ansible-playbook playbook.yml</code>{" "}
                    in a terminal hits your devices directly over SSH. No pipeline, no
                    runner. Great for a first test.
                  </li>
                  <li>
                    <strong>Through the pipeline</strong> — the runner executes
                    <code> ansible-playbook</code> for you on every merge. Because it has
                    to reach 10.x gear, this needs a <strong>self-hosted runner</strong> on
                    your network (cloud runners can't). We default to that below.
                  </li>
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Step 3 — something to deploy */}
        {step === 3 && (
          <div className="onboarding-body" data-testid="onboarding-step-3">
            <p>
              A pipeline needs Infrastructure-as-Code to run against — like a MOP
              needs a device to touch. Let's make sure there's something here.
            </p>
            {scan.status === "checking" && (
              <p className="onboarding-muted" data-testid="onboarding-scan-checking">
                Checking your workspace…
              </p>
            )}
            {scan.status === "has-code" && (
              <p className="onboarding-ok" data-testid="onboarding-scan-ok">
                ✓ Found {scan.count} {targetDef.scanNoun} file{scan.count === 1 ? "" : "s"} — you're
                good to go.
              </p>
            )}
            {(scan.status === "empty" || scan.status === "error") && (
              <div className="onboarding-empty" data-testid="onboarding-scan-empty">
                <p>
                  This workspace has no {targetDef.scanNoun} files yet. Want us to
                  create a small, safe starter{" "}
                  <code>{targetDef.scaffoldFile}</code>
                  {target === "network" && <> plus an <code>inventory.ini</code></>} so
                  your pipeline has something to plan?
                </p>
                <p className="onboarding-muted" data-testid="ob-device-edits-hint">
                  💡 {targetDef.deviceEditsHint}
                </p>
                {scan.status === "error" && (
                  <p className="onboarding-muted">({scan.message})</p>
                )}
              </div>
            )}
            {error && (
              <div className="iac-wizard-error" data-testid="onboarding-error">
                {error}
              </div>
            )}
          </div>
        )}

        {/* Step 4 — where it runs */}
        {step === 4 && (
          <div className="onboarding-body" data-testid="onboarding-step-4">
            <div className="iac-wizard-field">
              <label>Where does your team keep code?</label>
              <div className="iac-wizard-checks">
                <label>
                  <input
                    type="radio"
                    name="ob-platform"
                    checked={platform === "github"}
                    onChange={() => setPlatform("github")}
                    data-testid="ob-platform-github"
                  />{" "}
                  GitHub
                </label>
                <label>
                  <input
                    type="radio"
                    name="ob-platform"
                    checked={platform === "gitlab"}
                    onChange={() => setPlatform("gitlab")}
                    data-testid="ob-platform-gitlab"
                  />{" "}
                  GitLab
                </label>
              </div>
            </div>

            <div className="iac-wizard-field">
              <label>What should it do?</label>
              <label className="onboarding-radio-card">
                <input
                  type="radio"
                  name="ob-flow"
                  checked={flow === "plan-pr-apply-merge"}
                  onChange={() => setFlow("plan-pr-apply-merge")}
                  data-testid="ob-flow-apply"
                />
                <span>
                  <strong>Plan on PR, apply on merge</strong> <em>(recommended)</em>
                  <br />
                  <span className="onboarding-muted">
                    Shows the diff on every PR, applies automatically once merged.
                  </span>
                </span>
              </label>
              <label className="onboarding-radio-card">
                <input
                  type="radio"
                  name="ob-flow"
                  checked={flow === "plan-pr-only"}
                  onChange={() => setFlow("plan-pr-only")}
                  data-testid="ob-flow-plan"
                />
                <span>
                  <strong>Only plan on PR</strong> <em>(safer)</em>
                  <br />
                  <span className="onboarding-muted">
                    Shows the diff but never applies on its own — you run apply yourself.
                  </span>
                </span>
              </label>
            </div>

            <div className="iac-wizard-field">
              <label>Where should the pipeline run?</label>
              <label className="onboarding-radio-card">
                <input
                  type="radio"
                  name="ob-runner"
                  checked={runner === "self-hosted"}
                  onChange={() => setRunner("self-hosted")}
                  data-testid="ob-runner-self"
                />
                <span>
                  <strong>On my own machine</strong>{" "}
                  <em>(self-hosted{target !== "local" ? " — required for internal targets" : ""})</em>
                  <br />
                  <span className="onboarding-muted">
                    A runner you install on hardware that can reach your devices.
                    Nothing leaves your network.
                  </span>
                </span>
              </label>
              <label className="onboarding-radio-card">
                <input
                  type="radio"
                  name="ob-runner"
                  checked={runner === "cloud"}
                  onChange={() => setRunner("cloud")}
                  data-testid="ob-runner-cloud"
                />
                <span>
                  <strong>On {runnerLabelPlatform}'s runners</strong>{" "}
                  <em>(cloud-hosted)</em>
                  <br />
                  <span className="onboarding-muted">
                    Easiest to start. Can only reach internal devices through a
                    tunnel/VPN.
                  </span>
                </span>
              </label>

              {runner === "self-hosted" && (
                <details className="onboarding-guide" data-testid="ob-runner-guide">
                  <summary>How do I set up a self-hosted runner? (step by step)</summary>
                  {platform === "github" ? (
                    <ol className="onboarding-flow">
                      <li>In your repo on GitHub: <strong>Settings → Actions → Runners → New self-hosted runner</strong>.</li>
                      <li>Pick your OS. GitHub shows a block of download/config commands with a one-time token.</li>
                      <li>On a machine that can reach your devices, paste and run those commands (the last one is <code>./run.sh</code>).</li>
                      <li>To keep it running after logout, install it as a service: <code>sudo ./svc.sh install &amp;&amp; sudo ./svc.sh start</code>.</li>
                      <li>Done — your pipeline's <code>runs-on: self-hosted</code> jobs now execute there.</li>
                    </ol>
                  ) : (
                    <ol className="onboarding-flow">
                      <li>Install GitLab Runner: <code>brew install gitlab-runner</code> (mac) or the apt/yum package.</li>
                      <li>In your project: <strong>Settings → CI/CD → Runners</strong> and copy the registration token.</li>
                      <li>Run <code>gitlab-runner register</code>; paste the URL + token and choose the <strong>shell</strong> executor.</li>
                      <li>Give it the tag <code>self-hosted</code> when prompted, then start it: <code>gitlab-runner run</code>.</li>
                      <li>Done — the pipeline's <code>tags: [self-hosted]</code> jobs now run on it.</li>
                    </ol>
                  )}
                </details>
              )}
            </div>

            {targetDef.connectionLabel && (
              <div className="iac-wizard-field">
                <label>{targetDef.connectionLabel}</label>
                <input
                  data-testid="ob-connection"
                  value={connection}
                  placeholder={targetDef.connectionPlaceholder}
                  onChange={(e) => setConnection(e.target.value)}
                />
              </div>
            )}
          </div>
        )}

        {/* Step 5 — generate */}
        {step === 5 && (
          <div className="onboarding-body" data-testid="onboarding-step-5">
            <p>
              Ready. We'll write your pipeline file and show you a{" "}
              <strong>diff</strong> first — nothing lands on disk until you accept
              it. After that, we'll help you push it and show what's left.
            </p>
            <p className="onboarding-muted">
              Target: <strong>{targetDef.label}</strong> · {targetDef.tool} ·{" "}
              {runner === "self-hosted" ? "self-hosted runner" : "cloud runner"}
            </p>
            {error && (
              <div className="iac-wizard-error" data-testid="onboarding-error">
                {error}
              </div>
            )}
          </div>
        )}

        {/* Step 6 — next steps + push */}
        {step === 6 && (
          <div className="onboarding-body" data-testid="onboarding-step-6">
            {target === "network" && (
              <div className="onboarding-runnow" data-testid="ob-runnow">
                <strong>Want to try it right now — no pipeline needed?</strong>
                <p className="onboarding-muted">
                  Ansible connects to your devices directly over SSH. You can run the
                  playbook from here without pushing anything or setting up a runner.
                  Start with a dry-run (nothing changes).
                </p>
                <div className="onboarding-runnow-btns">
                  <button
                    className="iac-studio-run-check"
                    data-testid="ob-run-check"
                    onClick={() => runPlaybookDirect(true)}
                  >
                    ▷ Dry-run (--check)
                  </button>
                  <button
                    className="iac-studio-run-real"
                    data-testid="ob-run-real"
                    onClick={() => runPlaybookDirect(false)}
                  >
                    ▶ Run for real
                  </button>
                </div>
                <p className="onboarding-muted">
                  Opens a terminal and runs <code>ansible-playbook</code>. The CI
                  pipeline below is for when you want it to run automatically on every
                  change.
                </p>
              </div>
            )}
            <p>
              Pipeline written. Here's everything left to make it live — accept any
              open diff first.
            </p>
            <ol className="onboarding-checklist">
              <li>
                <strong>Push your code to {runnerLabelPlatform}.</strong> The pipeline
                only exists once these files land in a repo. Use the button below, or
                run it yourself:
                <pre className="onboarding-cmd">git add -A &amp;&amp; git commit -m "Add IaC pipeline" &amp;&amp; git push -u origin main</pre>
              </li>
              {runner === "self-hosted" && (
                <li>
                  <strong>Make sure your self-hosted runner is online.</strong> On{" "}
                  {runnerLabelPlatform}, check{" "}
                  {platform === "github"
                    ? "Settings → Actions → Runners (green = idle/online)"
                    : "Settings → CI/CD → Runners (green dot)"}
                  . Without it, <code>self-hosted</code> jobs sit queued.
                </li>
              )}
              <li>
                <strong>Edit what actually runs on your devices.</strong>{" "}
                {targetDef.deviceEditsHint} The pipeline just runs {targetDef.tool}; the
                changes live in those files.
              </li>
              <li>
                <strong>Open a Pull Request</strong> to see the plan, then merge to
                {flow === "plan-pr-apply-merge" ? " apply." : " (apply runs when you choose)."}
              </li>
            </ol>

            <div className="iac-wizard-field">
              <label>Remote URL (optional — where to push)</label>
              <input
                data-testid="ob-remote-url"
                value={remoteUrl}
                placeholder="git@github.com:you/your-repo.git"
                onChange={(e) => setRemoteUrl(e.target.value)}
                disabled={push.status === "working"}
              />
            </div>
            {push.status !== "idle" && (
              <div
                className={
                  push.status === "error" ? "iac-wizard-error" : "onboarding-ok"
                }
                data-testid="ob-push-status"
              >
                {push.note}
              </div>
            )}
          </div>
        )}

        {/* Footer actions */}
        <div className="iac-wizard-actions">
          <button
            className="iac-wizard-cancel"
            onClick={onClose}
            data-testid="onboarding-cancel"
          >
            {step === 6 ? "Done" : "Cancel"}
          </button>
          <div className="onboarding-nav">
            {step > 1 && step < 6 && (
              <button
                className="iac-wizard-cancel"
                onClick={() => setStep((s) => (s - 1) as Step)}
                disabled={generating}
                data-testid="onboarding-back"
              >
                Back
              </button>
            )}

            {step === 1 && (
              <button className="iac-wizard-generate" onClick={() => setStep(2)} data-testid="onboarding-next">
                Next ▸
              </button>
            )}

            {step === 2 && (
              <button className="iac-wizard-generate" onClick={() => setStep(3)} data-testid="onboarding-next">
                Next ▸
              </button>
            )}

            {step === 3 && scan.status === "has-code" && (
              <button className="iac-wizard-generate" onClick={() => setStep(4)} data-testid="onboarding-next">
                Next ▸
              </button>
            )}
            {step === 3 && (scan.status === "empty" || scan.status === "error") && (
              <>
                <button
                  className="iac-wizard-cancel"
                  onClick={() => setStep(4)}
                  disabled={generating}
                  data-testid="onboarding-skip-scaffold"
                >
                  I have code elsewhere
                </button>
                <button
                  className="iac-wizard-generate"
                  onClick={runScaffold}
                  disabled={generating}
                  data-testid="onboarding-scaffold"
                >
                  {generating ? "Creating…" : "Create starter file(s)"}
                </button>
              </>
            )}

            {step === 4 && (
              <button className="iac-wizard-generate" onClick={() => setStep(5)} data-testid="onboarding-next">
                Next ▸
              </button>
            )}

            {step === 5 && (
              <button
                className="iac-wizard-generate"
                onClick={runGenerate}
                disabled={generating}
                data-testid="onboarding-generate"
              >
                {generating ? "Building…" : "Build my pipeline ▸"}
              </button>
            )}

            {step === 6 && (
              <button
                className="iac-wizard-generate"
                onClick={runPush}
                disabled={push.status === "working" || push.status === "done"}
                data-testid="onboarding-push"
              >
                {push.status === "working"
                  ? "Pushing…"
                  : push.status === "done"
                    ? "Pushed ✓"
                    : "Commit & push ▸"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
