# IaC Studio Phase D — Guided Wizards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two modal wizards to IaC Studio — a resource-scaffolding wizard and a CI/CD pipeline wizard — that compose structured inputs into an NL intent, generate code through the existing Phase C codegen RPC, preview it via the existing `IacDiffPreview`, and write a **new** file into the workspace.

**Architecture:** Frontend + menu wiring only, plus one small Rust fix. Generation reuses `iacGenerateTerraform`/`iacGenerateAnsible`; the diff reuses `IacDiffPreview`; writes reuse `iac_studio_write_file`. The single new behavior is a `target_path` on `AiProposal` that makes the Studio's accept handler write a new file instead of editing the active buffer. Wizards are launched from native IaC menu items that ensure a Studio tab and set a `pending_wizard` store flag.

**Tech Stack:** React + TypeScript + Zustand (frontend), Tauri/Rust (menu + file write), vitest (tests). No DB migration (next free remains V0051).

**Spec:** `docs/superpowers/specs/2026-06-17-iac-studio-phaseD-wizards-design.md`

---

## File Structure

**Create:**
- `src/components/iac/IacResourceWizard.tsx` — resource-scaffolding modal form.
- `src/components/iac/IacResourceWizard.test.tsx` — vitest.
- `src/components/iac/IacPipelineWizard.tsx` — CI/CD pipeline modal form.
- `src/components/iac/IacPipelineWizard.test.tsx` — vitest.
- `src/components/iac/IacWizards.css` — shared modal styles for both wizards.

**Modify:**
- `src/state/iacStudioStore.ts` — add `pending_wizard` field + `setPendingWizard`; add optional `target_path` to `AiProposal`.
- `src-tauri/src/commands/editor.rs:449-457` — `iac_studio_write_file` creates parent dirs before writing.
- `src-tauri/src/lib.rs:744-747, 929-930` — two new IaC menu items + emit arms.
- `src/App.tsx:325-342` — two new `listen` handlers (ensure Studio tab + set pending wizard).
- `src/components/iac/IacStudioTab.tsx` — render the wizards when `pending_wizard` set; extend `onAcceptProposal` for the new-file write path; pass a `refreshKey` to `FileExplorer`.
- `src/components/editor/FileExplorer.tsx:19-38` — add optional `refreshKey` prop that re-loads the root tree.

---

## Task 1: `iac_studio_write_file` creates parent directories

The pipeline wizard writes `.github/workflows/terraform.yml`, whose parent dirs may not exist in a fresh repo. `validate_path` already allows new files under existing ancestors, but the write itself does not `create_dir_all`.

**Files:**
- Modify: `src-tauri/src/commands/editor.rs:449-457`
- Test: `src-tauri/src/commands/editor.rs` (in the existing `iac_studio_tests` mod)

- [ ] **Step 1: Write the failing test**

Add to the `iac_studio_tests` module in `src-tauri/src/commands/editor.rs`:

```rust
    #[test]
    fn write_creates_missing_parent_dirs_within_workspace() {
        let dir = TempDir::new().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let nested = dir.path().join(".github").join("workflows").join("terraform.yml");
        let fp = nested.to_string_lossy().to_string();

        rt().block_on(iac_studio_write_file(
            fp.clone(),
            "name: terraform\n".to_string(),
            Some(root.clone()),
        ))
        .expect("write should create parent dirs and succeed");

        assert_eq!(std::fs::read_to_string(&nested).unwrap(), "name: terraform\n");
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test iac_studio_tests::write_creates_missing_parent_dirs_within_workspace`
Expected: FAIL — `fs::write` errors with "No such file or directory" because `.github/workflows` does not exist.

- [ ] **Step 3: Create parent dirs before writing**

Replace the body of `iac_studio_write_file` (lines 449-457):

```rust
pub async fn iac_studio_write_file(
    file_path: String,
    content: String,
    workspace_root: Option<String>,
) -> Result<(), String> {
    let safe = validate_path(&file_path, workspace_root.as_deref())?;
    if let Some(parent) = safe.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create parent directories: {}", e))?;
    }
    fs::write(&safe, &content)
        .map_err(|e| format!("Failed to write file: {}", e))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test iac_studio_tests`
Expected: PASS — both the new test and the existing `read_then_write_round_trips_within_workspace`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/editor.rs
git commit -m "fix(iac): iac_studio_write_file creates parent dirs (Phase D pipelines)"
```

---

## Task 2: Store — `target_path` on `AiProposal` + `pending_wizard`

**Files:**
- Modify: `src/state/iacStudioStore.ts`
- Test: `src/state/iacStudioStore.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create or append to `src/state/iacStudioStore.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { useIacStudioStore, freshIacStudioState } from "./iacStudioStore";

describe("iacStudioStore pending_wizard", () => {
  beforeEach(() => useIacStudioStore.setState({ tabs: {} }));

  it("freshIacStudioState defaults pending_wizard to null", () => {
    expect(freshIacStudioState("/root").pending_wizard).toBeNull();
  });

  it("setPendingWizard sets and clears the flag", () => {
    const s = useIacStudioStore.getState();
    s.ensure("t1", "/root");
    s.setPendingWizard("t1", "resource");
    expect(useIacStudioStore.getState().tabs["t1"].pending_wizard).toBe("resource");
    s.setPendingWizard("t1", null);
    expect(useIacStudioStore.getState().tabs["t1"].pending_wizard).toBeNull();
  });

  it("setAiProposal preserves an optional target_path", () => {
    const s = useIacStudioStore.getState();
    s.ensure("t2", "/root");
    s.setAiProposal("t2", {
      code: "x", filename: "web.tf", explanation: "", target_path: "/root/web.tf",
      validation: { valid: null, skipped: true, error: null },
    });
    expect(useIacStudioStore.getState().tabs["t2"].ai.proposal?.target_path).toBe("/root/web.tf");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/state/iacStudioStore.test.ts`
Expected: FAIL — `pending_wizard`/`setPendingWizard` do not exist; `target_path` not in the `AiProposal` type.

- [ ] **Step 3: Implement store changes**

In `src/state/iacStudioStore.ts`:

Add `target_path` to the `AiProposal` interface (after `explanation`):

```ts
export interface AiProposal {
  code: string;
  filename: string;
  explanation: string;
  /** When set, accepting writes a NEW file at this path instead of editing the
   * active buffer. Absent for the Phase C buffer-edit path. */
  target_path?: string;
  validation: { valid: boolean | null; skipped: boolean; error: string | null };
}
```

Add to `IacStudioTabState` (after `ai: AiSlice;`):

```ts
  pending_wizard: "resource" | "pipeline" | null;
```

In the `IacStudioStore` interface, add the setter signature (after `setAiError`):

```ts
  setPendingWizard: (tabId: string, w: "resource" | "pipeline" | null) => void;
```

In `freshIacStudioState`, add to the returned object (after `ai: {...}`):

```ts
    pending_wizard: null,
```

Add the setter implementation to the store (after `setAiError`):

```ts
  setPendingWizard: (tabId, w) =>
    set((s) => {
      const cur = s.tabs[tabId];
      if (!cur) return s;
      return { tabs: { ...s.tabs, [tabId]: { ...cur, pending_wizard: w } } };
    }),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/state/iacStudioStore.test.ts`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/state/iacStudioStore.ts src/state/iacStudioStore.test.ts
git commit -m "feat(iac): store pending_wizard flag + AiProposal target_path (Phase D)"
```

---

## Task 3: FileExplorer `refreshKey` prop

After a wizard writes a new file, the tree must reload. `FileExplorer` currently reloads only when `rootPath` changes.

**Files:**
- Modify: `src/components/editor/FileExplorer.tsx:12-38`
- Test: covered indirectly by Task 7's wizard E2E; no standalone test (the change is a one-line dependency add).

- [ ] **Step 1: Add the optional prop to the interface**

In `src/components/editor/FileExplorer.tsx`, add to `FileExplorerProps` (after `rootPath: string | null;`):

```ts
  /** Bump to force the root tree to reload (e.g. after a wizard writes a file). */
  refreshKey?: number;
```

- [ ] **Step 2: Destructure and use it in the load effect**

Change the destructure (line 19-25) to include `refreshKey`:

```tsx
export function FileExplorer({
  rootPath,
  expandedDirs,
  onSelectFile,
  onToggleDir,
  gitStatus,
  refreshKey,
}: FileExplorerProps) {
```

Change the load effect (lines 35-38) to depend on `refreshKey`:

```tsx
  useEffect(() => {
    if (!rootPath) return;
    loadDirectory(rootPath);
  }, [rootPath, refreshKey]);
```

- [ ] **Step 3: Verify the existing FileExplorer tests still pass**

Run: `npx vitest run src/components/editor/FileExplorer.test.tsx`
Expected: PASS (prop is optional; existing callers unaffected).

- [ ] **Step 4: Commit**

```bash
git add src/components/editor/FileExplorer.tsx
git commit -m "feat(editor): FileExplorer refreshKey prop to force tree reload"
```

---

## Task 4: `IacResourceWizard` component

A modal form that composes provider/type/name/details into an NL intent, calls the codegen RPC, and emits an `AiProposal` with a `target_path`.

**Files:**
- Create: `src/components/iac/IacResourceWizard.tsx`
- Create: `src/components/iac/IacWizards.css`
- Test: `src/components/iac/IacResourceWizard.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/iac/IacResourceWizard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IacResourceWizard } from "./IacResourceWizard";

const generateTerraform = vi.fn();
vi.mock("../../lib/tauri", () => ({
  iacGenerateTerraform: (...a: unknown[]) => generateTerraform(...a),
  iacGenerateAnsible: vi.fn(),
}));

function okResult() {
  return {
    tool: "terraform", code: 'resource "aws_instance" "web_server" {}',
    filename: "web_server.tf", explanation: "an instance",
    estimated_apply_time_seconds: 10,
    validation: { valid: null, skipped: true, error: null }, unavailable: false,
  };
}

describe("IacResourceWizard", () => {
  beforeEach(() => generateTerraform.mockReset());

  it("composes an intent from the fields and emits a proposal with target_path", async () => {
    generateTerraform.mockResolvedValue(okResult());
    const onProposal = vi.fn();
    render(
      <IacResourceWizard rootPath="/root" onProposal={onProposal} onClose={vi.fn()} />,
    );
    fireEvent.change(screen.getByTestId("res-type"), { target: { value: "aws_instance" } });
    fireEvent.change(screen.getByTestId("res-name"), { target: { value: "web_server" } });
    fireEvent.change(screen.getByTestId("res-details"), { target: { value: "t3.micro" } });
    fireEvent.click(screen.getByTestId("res-generate"));

    await waitFor(() => expect(onProposal).toHaveBeenCalled());
    const intent = generateTerraform.mock.calls[0][0] as string;
    expect(intent).toContain("aws_instance");
    expect(intent).toContain("web_server");
    expect(intent).toContain("t3.micro");
    const proposal = onProposal.mock.calls[0][0];
    expect(proposal.target_path).toBe("/root/web_server.tf");
  });

  it("surfaces an honest error and emits no proposal when unavailable", async () => {
    generateTerraform.mockResolvedValue({ ...okResult(), unavailable: true, code: "" });
    const onProposal = vi.fn();
    render(<IacResourceWizard rootPath="/root" onProposal={onProposal} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("res-type"), { target: { value: "aws_instance" } });
    fireEvent.change(screen.getByTestId("res-name"), { target: { value: "web_server" } });
    fireEvent.click(screen.getByTestId("res-generate"));
    await waitFor(() => expect(screen.getByTestId("res-error")).toBeInTheDocument());
    expect(onProposal).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/iac/IacResourceWizard.test.tsx`
Expected: FAIL — module `./IacResourceWizard` not found.

- [ ] **Step 3: Implement the component + styles**

Create `src/components/iac/IacWizards.css`:

```css
.iac-wizard-overlay {
  position: absolute; inset: 0; z-index: 40;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.5);
}
.iac-wizard-modal {
  width: 480px; max-width: 90%;
  background: #1e1e1e; color: #ddd;
  border: 1px solid #444; border-radius: 6px;
  padding: 16px; display: flex; flex-direction: column; gap: 10px;
}
.iac-wizard-title { font-weight: 600; font-size: 14px; }
.iac-wizard-field { display: flex; flex-direction: column; gap: 4px; }
.iac-wizard-field label { font-size: 12px; color: #aaa; }
.iac-wizard-field input,
.iac-wizard-field select,
.iac-wizard-field textarea {
  background: #2a2a2a; color: #eee; border: 1px solid #555;
  border-radius: 4px; padding: 6px; font-size: 13px;
}
.iac-wizard-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
.iac-wizard-actions button { padding: 6px 14px; border-radius: 4px; cursor: pointer; }
.iac-wizard-generate { background: #0e639c; color: #fff; border: none; }
.iac-wizard-generate:disabled { opacity: 0.5; cursor: not-allowed; }
.iac-wizard-cancel { background: transparent; color: #ccc; border: 1px solid #555; }
.iac-wizard-error { color: #f48771; font-size: 12px; }
.iac-wizard-checks { display: flex; gap: 14px; }
.iac-wizard-checks label { display: flex; align-items: center; gap: 5px; font-size: 13px; color: #ddd; }
```

Create `src/components/iac/IacResourceWizard.tsx`:

```tsx
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/iac/IacResourceWizard.test.tsx`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/components/iac/IacResourceWizard.tsx src/components/iac/IacResourceWizard.test.tsx src/components/iac/IacWizards.css
git commit -m "feat(iac): IacResourceWizard — guided resource scaffolding (Phase D)"
```

---

## Task 5: `IacPipelineWizard` component

A modal form that, for each selected platform, composes a platform-specific intent and emits one `AiProposal` per platform (with the correct `target_path`). Proposals are emitted sequentially: the parent (Studio) shows one diff at a time and calls `onProposalAccepted`/`onProposalRejected` to advance.

Design note: to keep the wizard testable and decoupled from the diff overlay, it builds the **full list** of proposals on Generate and hands them to the parent via `onProposals(list)`. The Studio drives them through `IacDiffPreview` one at a time (Task 6).

**Files:**
- Create: `src/components/iac/IacPipelineWizard.tsx`
- Test: `src/components/iac/IacPipelineWizard.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `src/components/iac/IacPipelineWizard.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { IacPipelineWizard } from "./IacPipelineWizard";

const generateTerraform = vi.fn();
vi.mock("../../lib/tauri", () => ({
  iacGenerateTerraform: (...a: unknown[]) => generateTerraform(...a),
  iacGenerateAnsible: vi.fn(),
}));

function res(code: string) {
  return {
    tool: "terraform", code, filename: "pipeline.yml", explanation: "",
    estimated_apply_time_seconds: 5,
    validation: { valid: null, skipped: true, error: null }, unavailable: false,
  };
}

describe("IacPipelineWizard", () => {
  beforeEach(() => generateTerraform.mockReset());

  it("both platforms selected => two proposals with correct target paths", async () => {
    generateTerraform.mockResolvedValueOnce(res("on: pull_request")).mockResolvedValueOnce(res("stages:"));
    const onProposals = vi.fn();
    render(<IacPipelineWizard rootPath="/root" detectedTool="terraform" onProposals={onProposals} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("pipe-gh"));      // GitHub Actions
    fireEvent.click(screen.getByTestId("pipe-gl"));      // GitLab CI
    fireEvent.click(screen.getByTestId("pipe-generate"));

    await waitFor(() => expect(onProposals).toHaveBeenCalled());
    const proposals = onProposals.mock.calls[0][0];
    expect(proposals).toHaveLength(2);
    expect(proposals[0].target_path).toBe("/root/.github/workflows/terraform.yml");
    expect(proposals[1].target_path).toBe("/root/.gitlab-ci.yml");
  });

  it("folds auth/env text into the intent", async () => {
    generateTerraform.mockResolvedValue(res("on: pull_request"));
    render(<IacPipelineWizard rootPath="/root" detectedTool="terraform" onProposals={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("pipe-gh"));
    fireEvent.change(screen.getByTestId("pipe-auth"), { target: { value: "AWS via OIDC" } });
    fireEvent.click(screen.getByTestId("pipe-generate"));
    await waitFor(() => expect(generateTerraform).toHaveBeenCalled());
    expect(generateTerraform.mock.calls[0][0]).toContain("AWS via OIDC");
  });

  it("requires at least one platform", () => {
    render(<IacPipelineWizard rootPath="/root" detectedTool="terraform" onProposals={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId("pipe-generate")).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/iac/IacPipelineWizard.test.tsx`
Expected: FAIL — module `./IacPipelineWizard` not found.

- [ ] **Step 3: Implement the component**

Create `src/components/iac/IacPipelineWizard.tsx`:

```tsx
import { useEffect, useState } from "react";
import { iacGenerateTerraform, iacGenerateAnsible, type CodegenResult } from "../../lib/tauri";
import type { AiProposal } from "../../state/iacStudioStore";
import "./IacWizards.css";

type Platform = "github" | "gitlab";
type Flow = "plan-pr-apply-merge" | "plan-pr-only";

function joinPath(root: string, rel: string): string {
  return `${root.replace(/\/+$/, "")}/${rel}`;
}

const FLOW_LABEL: Record<Flow, string> = {
  "plan-pr-apply-merge": "plan-on-PR + apply-on-merge",
  "plan-pr-only": "plan-on-PR only",
};

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

  function targetFor(p: Platform): string {
    const rel =
      p === "github"
        ? `.github/workflows/${tool === "terraform" ? "terraform" : "ansible"}.yml`
        : ".gitlab-ci.yml";
    return rootPath ? joinPath(rootPath, rel) : rel;
  }

  function intentFor(p: Platform): string {
    const platformName = p === "github" ? "GitHub Actions" : "GitLab CI";
    const target = p === "github" ? ".github/workflows/" : ".gitlab-ci.yml";
    return (
      `Generate a ${platformName} CI/CD pipeline (${target}) for a ${tool} project ` +
      `implementing "${FLOW_LABEL[flow]}".` +
      (auth.trim() ? ` Auth/environment: ${auth.trim()}.` : "") +
      ` Output only the pipeline YAML.`
    );
  }

  async function runGenerate() {
    if (!canGenerate) return;
    setGenerating(true);
    setError(null);
    const gen = tool === "terraform" ? iacGenerateTerraform : iacGenerateAnsible;
    const proposals: AiProposal[] = [];
    try {
      for (const p of platforms) {
        const result: CodegenResult = await gen(intentFor(p), rootPath ?? ".", undefined, "");
        if (result.unavailable || !result.code.trim()) {
          setError(
            "Generation unavailable — the AI model returned no usable code. " +
              "Check the LLM provider in Settings.",
          );
          return;
        }
        const target = targetFor(p);
        proposals.push({
          code: result.code,
          filename: target.split("/").pop() ?? "pipeline.yml",
          explanation: result.explanation,
          validation: result.validation,
          target_path: target,
        });
      }
      onProposals(proposals);
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/iac/IacPipelineWizard.test.tsx`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add src/components/iac/IacPipelineWizard.tsx src/components/iac/IacPipelineWizard.test.tsx
git commit -m "feat(iac): IacPipelineWizard — GitHub Actions + GitLab CI generation (Phase D)"
```

---

## Task 6: Wire wizards into `IacStudioTab` + new-file accept path

Render the wizards when `pending_wizard` is set, drive pipeline proposals through `IacDiffPreview` one at a time, and extend `onAcceptProposal` to write a new file when `target_path` is present.

**Files:**
- Modify: `src/components/iac/IacStudioTab.tsx`
- Test: `src/components/iac/IacStudioTab.test.tsx`

- [ ] **Step 1: Write the failing test**

Append to `src/components/iac/IacStudioTab.test.tsx` a test that accepting a `target_path` proposal calls `iacStudioWriteFile`. Add to the existing `vi.mock("../../lib/tauri", ...)` (or extend it) so `iacStudioWriteFile` is a spy:

```tsx
// Within the existing tauri mock, ensure these are present:
//   iacStudioWriteFile: (...a) => writeFileSpy(...a),
//   iacStudioReadFile: vi.fn().mockResolvedValue({ file_path: "/root/web.tf", content: "x", language: "hcl" }),

import { useIacStudioStore } from "../../state/iacStudioStore";

it("accepting a proposal with target_path writes a new file", async () => {
  const { getByTestId } = render(<IacStudioTab tab={makeIacTab("/root")} />);
  const tabId = makeIacTabId; // however the existing tests reference the tab id
  // Seed a proposal carrying a target_path:
  useIacStudioStore.getState().ensure(tabId, "/root");
  useIacStudioStore.getState().setAiProposal(tabId, {
    code: 'resource "x" {}', filename: "web.tf", explanation: "",
    target_path: "/root/web.tf",
    validation: { valid: null, skipped: true, error: null },
  });
  // The diff overlay should render; click Accept.
  fireEvent.click(getByTestId("iac-diff-accept"));
  await waitFor(() => expect(writeFileSpy).toHaveBeenCalledWith("/root/web.tf", 'resource "x" {}', "/root"));
});
```

Note: align `makeIacTab`/tab-id helpers with whatever the existing `IacStudioTab.test.tsx` already uses. If the existing test file constructs the tab inline, mirror that exactly rather than inventing helpers.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/iac/IacStudioTab.test.tsx`
Expected: FAIL — `onAcceptProposal` currently calls `setContent`, never `iacStudioWriteFile`, so the spy is not called.

- [ ] **Step 3: Implement the wiring**

In `src/components/iac/IacStudioTab.tsx`:

Add imports:

```tsx
import { IacResourceWizard } from "./IacResourceWizard";
import { IacPipelineWizard } from "./IacPipelineWizard";
```

Add store selectors (near the other `useIacStudioStore` selectors):

```tsx
  const setPendingWizard = useIacStudioStore((s) => s.setPendingWizard);
```

Add local state for the pipeline proposal queue and a tree refresh counter (near `editorReady`):

```tsx
  const [pipelineQueue, setPipelineQueue] = useState<AiProposal[]>([]);
  const [treeRefresh, setTreeRefresh] = useState(0);
```

Import the `AiProposal` type:

```tsx
import { useIacStudioStore, freshIacStudioState, type AiProposal } from "../../state/iacStudioStore";
```

Replace `onAcceptProposal` (lines 121-126) with a version that handles `target_path`, then dequeues the next pipeline proposal:

```tsx
  const advanceQueue = useCallback(() => {
    setPipelineQueue((q) => {
      const [, ...rest] = q;
      if (rest.length > 0) setAiProposal(tab.id, rest[0]);
      return rest;
    });
  }, [tab.id, setAiProposal]);

  const onAcceptProposal = useCallback(async () => {
    const proposal = state.ai.proposal;
    if (!proposal) return;
    if (proposal.target_path) {
      try {
        await iacStudioWriteFile(proposal.target_path, proposal.code, state.root_path);
        const lang = proposal.target_path.endsWith(".tf") || proposal.target_path.endsWith(".hcl")
          ? "hcl" : "yaml";
        openFileInStore(tab.id, proposal.target_path, proposal.code, lang);
        setTreeRefresh((n) => n + 1);
      } catch (err) {
        patch(tab.id, { error: err instanceof Error ? err.message : String(err) });
        clearAiProposal(tab.id);
        return;
      }
    } else {
      setContent(tab.id, proposal.code); // Phase C buffer edit
    }
    clearAiProposal(tab.id);
    advanceQueue();
  }, [state.ai.proposal, state.root_path, tab.id, setContent, clearAiProposal, openFileInStore, patch, advanceQueue]);
```

Update the reject handler for the diff to also advance the queue. Replace the `onReject` in the `IacDiffPreview` render (line 220) with:

```tsx
          onReject={() => { clearAiProposal(tab.id); advanceQueue(); }}
```

Pass `refreshKey` to `FileExplorer` (line 156-161):

```tsx
        <FileExplorer
          rootPath={state.root_path}
          expandedDirs={state.expanded_dirs}
          onSelectFile={onOpenFile}
          onToggleDir={(dir) => toggleDir(tab.id, dir)}
          refreshKey={treeRefresh}
        />
```

Detect the workspace tool for the pipeline wizard default (simple heuristic from the open file / language; default Terraform):

```tsx
  const detectedTool: "terraform" | "ansible" =
    state.language === "yaml" || (state.file_path ?? "").match(/\.ya?ml$/) ? "ansible" : "terraform";
```

Render the wizards before the closing `</div>` of the tab (after the `IacDiffPreview` block), gated on `pending_wizard` and only when no diff is currently showing:

```tsx
      {state.pending_wizard === "resource" && !state.ai.proposal && (
        <IacResourceWizard
          rootPath={state.root_path}
          onProposal={(p) => setAiProposal(tab.id, p)}
          onClose={() => setPendingWizard(tab.id, null)}
        />
      )}
      {state.pending_wizard === "pipeline" && !state.ai.proposal && (
        <IacPipelineWizard
          rootPath={state.root_path}
          detectedTool={detectedTool}
          onProposals={(ps) => {
            setPendingWizard(tab.id, null);
            if (ps.length > 0) {
              setPipelineQueue(ps);
              setAiProposal(tab.id, ps[0]);
            }
          }}
          onClose={() => setPendingWizard(tab.id, null)}
        />
      )}
```

Note on closing the resource wizard: it calls `onProposal` then `onClose`. Because `onClose` sets `pending_wizard` to null and `onProposal` sets the diff, the diff overlay renders and the wizard unmounts — correct.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/iac/IacStudioTab.test.tsx`
Expected: PASS — including the existing Phase C tests (buffer-edit path unchanged when `target_path` absent).

- [ ] **Step 5: Commit**

```bash
git add src/components/iac/IacStudioTab.tsx src/components/iac/IacStudioTab.test.tsx
git commit -m "feat(iac): wire resource + pipeline wizards into IacStudioTab (Phase D)"
```

---

## Task 7: Menu wiring — IaC menu items + App.tsx handlers

**Files:**
- Modify: `src-tauri/src/lib.rs:744-747, 929-930`
- Modify: `src/App.tsx:325-342`

- [ ] **Step 1: Add menu items in lib.rs**

Replace lines 745-747:

```rust
            let iac_state_open = MenuItem::with_id(app, "iac_state_open", "Open Terraform State", true, Some("CmdOrCtrl+Shift+S"))?;
            let iac_studio_open = MenuItem::with_id(app, "iac_studio_open", "Open IaC Studio", true, Some("CmdOrCtrl+Shift+E"))?;
            let iac_new_resource = MenuItem::with_id(app, "iac_new_resource", "New Resource…", true, None::<&str>)?;
            let iac_new_pipeline = MenuItem::with_id(app, "iac_new_pipeline", "New Pipeline…", true, None::<&str>)?;
            let iac_menu = Submenu::with_items(app, "IaC", true, &[&iac_studio_open, &iac_state_open, &iac_new_resource, &iac_new_pipeline])?;
```

- [ ] **Step 2: Add emit arms in lib.rs**

After line 930 (`"iac_studio_open" => ...`):

```rust
                    "iac_new_resource" => { window.emit("menu:iac_new_resource", ()).ok(); }
                    "iac_new_pipeline" => { window.emit("menu:iac_new_pipeline", ()).ok(); }
```

- [ ] **Step 3: Add App.tsx listeners**

In `src/App.tsx`, after the `menu:iac_studio_open` handler (ends at line 342), add a shared helper inline and two listeners. First, ensure the store setter is imported — add to the existing iac studio store import:

```tsx
import { useIacStudioStore } from "./state/iacStudioStore";
```

Then add the listeners (uses the same cwd-resolution as `iac_studio_open`):

```tsx
    const launchWizard = (wizard: "resource" | "pipeline") => {
      const st = useTabs.getState();
      const activeTabId = st.activeTabId;
      const activeTab = st.tabs.find((t) => t.id === activeTabId);
      // Reuse an existing IaC Studio tab if one is open; else create one.
      let studioTab = st.tabs.find((t) => t.tab_type === "iac-studio");
      let liveCwd: string | undefined;
      if (activeTabId) {
        const ptyId = usePanesStore.getState().resolveRecordingTerminalId(activeTabId);
        liveCwd = useIacStateStore.getState().cwdByTerminal[ptyId];
      }
      if (!studioTab) {
        const id = crypto.randomUUID();
        st.addTab({
          id,
          title: "IaC Studio",
          shell_cmd: "",
          cwd: liveCwd ?? activeTab?.cwd ?? ".",
          created_at: Math.floor(Date.now() / 1000),
          tab_type: "iac-studio" as const,
        });
        studioTab = useTabs.getState().tabs.find((t) => t.id === id);
      } else {
        st.setActiveTab(studioTab.id);
      }
      if (studioTab) {
        useIacStudioStore.getState().ensure(studioTab.id, studioTab.cwd ?? ".");
        useIacStudioStore.getState().setPendingWizard(studioTab.id, wizard);
      }
    };

    unlistens.push(listen('menu:iac_new_resource', () => launchWizard("resource")));
    unlistens.push(listen('menu:iac_new_pipeline', () => launchWizard("pipeline")));
```

Note: confirm the tabs store exposes `setActiveTab` (grep `setActiveTab` in `src/state`); if the setter has a different name (e.g. `setActiveTabId`), use that. If neither exists, drop the `else` branch — creating/ensuring the tab is sufficient for the wizard to appear.

- [ ] **Step 4: Build to verify Rust + TS compile**

Run: `cd src-tauri && cargo build 2>&1 | tail -5`
Expected: builds clean (no errors).

Run: `npx tsc --noEmit 2>&1 | tail -5`
Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/lib.rs src/App.tsx
git commit -m "feat(iac): IaC menu New Resource / New Pipeline launchers (Phase D)"
```

---

## Task 8: Full regression + manual E2E

**Files:** none (verification only).

- [ ] **Step 1: Run the full frontend test suite**

Run: `npx vitest run`
Expected: PASS — all prior tests plus the new wizard/store tests.

- [ ] **Step 2: Run the Rust test suite**

Run: `cd src-tauri && cargo test`
Expected: PASS — including the new parent-dir test.

- [ ] **Step 3: Manual E2E (per spec verification section)**

Run: `npm run tauri dev`

Resource wizard:
- IaC menu → New Resource… → provider=aws, type=aws_instance, name=web_server, details="t3.micro" → Generate.
- Confirm a diff preview appears; Accept.
- Confirm `web_server.tf` exists on disk in the workspace and opens in the editor; the file tree shows it.

Pipeline wizard:
- IaC menu → New Pipeline… → check GitHub Actions + GitLab CI, Tool=Terraform, flow=plan-on-PR + apply-on-merge, auth="AWS via OIDC" → Generate.
- Accept the GitHub Actions diff, then the GitLab diff.
- Confirm `.github/workflows/terraform.yml` and `.gitlab-ci.yml` exist and are valid YAML.

Binary-absent honesty:
- With `terraform` off PATH, run either wizard and confirm the diff note reads "syntax not validated", never "valid".

- [ ] **Step 4: Update the master design doc**

Mark Phase D as delivered in `docs/superpowers/specs/2026-06-15-iac-studio-design.md` (add a "✅ DELIVERED" note to the Phase D heading, mirroring Phase C's format), noting any deviations discovered during the live review.

- [ ] **Step 5: Final commit**

```bash
git add docs/superpowers/specs/2026-06-15-iac-studio-design.md
git commit -m "docs(iac): mark IaC Studio Phase D delivered"
```

---

## Self-Review Notes

- **Spec coverage:** menu launch (Task 7), resource wizard light form (Task 4), CI/CD wizard platform+tool+flow+env (Task 5), new-file diff-preview write (Tasks 1, 2, 6), honest validation/unavailable (Tasks 4, 5 tests + reused `IacDiffPreview`), workspace-scoped writes (reused `validate_path`), no DB migration (none added). All covered.
- **Type consistency:** `AiProposal.target_path?` defined in Task 2 and consumed in Tasks 4, 5, 6. `setPendingWizard` defined Task 2, used Tasks 6, 7. `pending_wizard` field defined Task 2, read Task 6. `refreshKey` defined Task 3, passed Task 6. Pipeline wizard uses `onProposals` (list) consistently in Task 5 test, component, and Task 6 wiring.
- **Known caller-alignment notes (flagged inline, not placeholders):** Task 6 references the existing `IacStudioTab.test.tsx` tab-construction helpers (mirror them); Task 7 verifies the exact tabs-store active-tab setter name. These are explicit "match the existing pattern" instructions, not deferred work.
