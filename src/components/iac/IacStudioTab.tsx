import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type * as Monaco from "monaco-editor";
import type { Tab } from "../../lib/types";
import { iacStudioReadFile, iacStudioWriteFile, editorListDirectory } from "../../lib/tauri";
import { useIacStudioStore, freshIacStudioState, type AiProposal } from "../../state/iacStudioStore";
import { EditorActionToolbar } from "../editor/EditorActionToolbar";
import { MonacoEditor } from "../editor/MonacoEditor";
import { FileExplorer } from "../editor/FileExplorer";
import { useEditorSettings } from "../../hooks/useEditorSettings";
import { useIacLint } from "../../hooks/useIacLint";
import { IacProblemsPanel } from "./IacProblemsPanel";
import { IacAiPanel } from "./IacAiPanel";
import { IacDiffPreview } from "./IacDiffPreview";
import { IacResourceWizard } from "./IacResourceWizard";
import { IacPipelineWizard } from "./IacPipelineWizard";
import { IacFileChooser } from "./IacFileChooser";
import { PipelineOnboardingWizard } from "./PipelineOnboardingWizard";
import { PushToGitModal } from "./PushToGitModal";
import { GitHubRunsPanel } from "./GitHubRunsPanel";
import { EditorCoachMarks } from "../editor/EditorCoachMarks";
import { computePipelineAnchors, toCoachSteps } from "../editor/coachMarkAnchors";
import { buildPlaybookCommand, runInTerminal, isAnsiblePlaybook } from "./runPlaybook";
import "./IacStudioTab.css";

export function IacStudioTab({ tab }: { tab: Tab }) {
  const rootPath = tab.cwd && tab.cwd !== "/" ? tab.cwd : ".";
  const ensure = useIacStudioStore((s) => s.ensure);
  const storedState = useIacStudioStore((s) => s.tabs[tab.id]);
  // The store entry is seeded by the useEffect below, which runs AFTER the
  // first render. Use a pure (non-mutating) fallback so `state` is always
  // defined during render — every hook below reads state.* in its deps.
  const fallback = useMemo(() => freshIacStudioState(rootPath), [rootPath]);
  const state = storedState ?? fallback;
  const patch = useIacStudioStore((s) => s.patch);
  const openFileInStore = useIacStudioStore((s) => s.openFile);
  const setContent = useIacStudioStore((s) => s.setContent);
  const setDirty = useIacStudioStore((s) => s.setDirty);
  const setCursor = useIacStudioStore((s) => s.setCursor);
  const toggleDir = useIacStudioStore((s) => s.toggleDir);
  const setRoot = useIacStudioStore((s) => s.setRoot);
  const setStudioDiagnostics = useIacStudioStore((s) => s.setDiagnostics);
  const setAiGenerating = useIacStudioStore((s) => s.setAiGenerating);
  const setAiProposal = useIacStudioStore((s) => s.setAiProposal);
  const clearAiProposal = useIacStudioStore((s) => s.clearAiProposal);
  const setAiError = useIacStudioStore((s) => s.setAiError);
  const setPendingWizard = useIacStudioStore((s) => s.setPendingWizard);
  const setCoachPending = useIacStudioStore((s) => s.setCoachPending);
  const startCoach = useIacStudioStore((s) => s.startCoach);
  const coachNext = useIacStudioStore((s) => s.coachNext);
  const coachBack = useIacStudioStore((s) => s.coachBack);
  const coachEnd = useIacStudioStore((s) => s.coachEnd);

  const { settings } = useEditorSettings();
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof Monaco | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  // Pipeline wizard can return multiple proposals; they're shown one diff at a
  // time. Only the setter is read directly — advanceQueue consumes the queue via
  // a functional update, so the value binding itself is intentionally elided.
  const [, setPipelineQueue] = useState<AiProposal[]>([]);
  const [showPushModal, setShowPushModal] = useState(false);
  const [showRunsPanel, setShowRunsPanel] = useState(false);
  // When a New Resource/Pipeline menu action fires, we first show a chooser
  // (create-new vs edit/delete existing). "Create new" flips this to true and
  // the actual generation wizard renders. Reset whenever pending_wizard changes.
  const [creatingNew, setCreatingNew] = useState(false);
  const [treeRefresh, setTreeRefresh] = useState(0);

  useEffect(() => {
    ensure(tab.id, rootPath);
  }, [tab.id, rootPath, ensure]);

  const { diagnostics, linters } = useIacLint({
    filePath: state.file_path,
    content: state.content,
    language: state.language,
  });

  useEffect(() => {
    setStudioDiagnostics(tab.id, { diagnostics, linters });
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    if (!editor || !monaco) return;
    const model = editor.getModel();
    if (!model) return;
    monaco.editor.setModelMarkers(
      model,
      "iac-lint",
      diagnostics.map((d) => ({
        startLineNumber: d.line,
        startColumn: d.column,
        endLineNumber: d.line,
        endColumn: 1000,
        message: `${d.message} (${d.source})`,
        severity:
          d.severity === "error"
            ? monaco.MarkerSeverity.Error
            : d.severity === "warning"
              ? monaco.MarkerSeverity.Warning
              : monaco.MarkerSeverity.Info,
      })),
    );
  }, [diagnostics, linters, tab.id, setStudioDiagnostics, editorReady]);

  const onOpenFile = useCallback(
    async (filePath: string) => {
      patch(tab.id, { loading: true, error: null });
      try {
        const file = await iacStudioReadFile(filePath, state.root_path);
        openFileInStore(tab.id, file.file_path, file.content, file.language);
        patch(tab.id, { loading: false });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        patch(tab.id, { error: msg, loading: false });
      }
    },
    [tab.id, patch, openFileInStore, state.root_path],
  );

  // Each time a New Resource/Pipeline action opens, start on the chooser (not
  // straight into create). Keyed on pending_wizard so re-opening resets it.
  useEffect(() => {
    setCreatingNew(false);
  }, [state.pending_wizard]);

  const onSave = useCallback(async () => {
    if (!state.file_path) return;
    patch(tab.id, { loading: true, error: null });
    try {
      await iacStudioWriteFile(state.file_path, state.content, state.root_path);
      setDirty(tab.id, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      patch(tab.id, { error: msg });
    } finally {
      patch(tab.id, { loading: false });
    }
  }, [state.file_path, state.content, state.root_path, tab.id, patch, setDirty]);

  const onBrowse = useCallback(async () => {
    const { open: openDialog } = await import("@tauri-apps/plugin-dialog");
    const picked = await openDialog({ directory: true, defaultPath: state.root_path ?? undefined });
    if (typeof picked === "string") setRoot(tab.id, picked);
  }, [tab.id, state.root_path, setRoot]);

  const onJumpTo = useCallback((line: number, column: number) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
  }, []);

  const detectedTool: "terraform" | "ansible" =
    state.language === "yaml" || /\.ya?ml$/.test(state.file_path ?? "") ? "ansible" : "terraform";

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
        const lang =
          proposal.target_path.endsWith(".tf") || proposal.target_path.endsWith(".hcl")
            ? "hcl"
            : "yaml";
        openFileInStore(tab.id, proposal.target_path, proposal.code, lang);
        setTreeRefresh((n) => n + 1);
        // Onboarding hand-off: if the just-written file is the pipeline YAML and
        // coach-marks were armed, walk the user through its sections.
        if (state.coach_pending && /\.ya?ml$/.test(proposal.target_path)) {
          const platform = proposal.target_path.includes(".gitlab-ci")
            ? "gitlab"
            : "github";
          const steps = toCoachSteps(computePipelineAnchors(proposal.code, platform));
          startCoach(tab.id, steps);
        }
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
  }, [state.ai.proposal, state.root_path, state.coach_pending, tab.id, setContent, clearAiProposal, openFileInStore, patch, advanceQueue, startCoach]);

  // Direct-SSH run: is the open file an Ansible playbook? If so, offer to run it
  // in a terminal (no CI runner needed — ansible-playbook SSHes to devices).
  const canRunPlaybook = isAnsiblePlaybook(state.file_path);
  const canRunTerraform = !!state.file_path && /\.tf$/.test(state.file_path);

  const runPlaybookNow = useCallback(
    async (check: boolean) => {
      if (!state.file_path) return;
      const playbook = state.file_path.split("/").pop() ?? "playbook.yml";
      // Look for a sibling inventory to pass with -i (best-effort; a missing
      // inventory just runs against ansible defaults).
      let inventory: string | null = null;
      try {
        const nodes = await editorListDirectory(state.root_path ?? ".");
        const inv = nodes.find(
          (n) => n.node_type === "file" && /^inventory\.(ini|ya?ml)$/.test(n.name),
        );
        if (inv) inventory = inv.name;
      } catch {
        /* best-effort */
      }
      const cmd = buildPlaybookCommand({ playbook, inventory, check });
      runInTerminal(cmd, state.root_path);
    },
    [state.file_path, state.root_path],
  );

  return (
    <div className="iac-studio-tab" data-testid="iac-studio-tab">
      <div className="iac-studio-toolbar">
        <span className="iac-studio-title">IaC Studio</span>
        <span className="iac-studio-workspace" title={state.root_path ?? ""}>
          {state.root_path ?? "(no workspace)"}
        </span>
        <button onClick={onBrowse} title="Choose workspace folder" data-testid="iac-studio-browse">
          Browse…
        </button>
        <div className="iac-studio-spacer" />
        {state.file_path && (
          <span className="iac-studio-file">
            {state.file_path.split("/").pop()}
            {state.is_dirty && <span className="dirty-marker"> ●</span>}
          </span>
        )}
        {canRunPlaybook && (
          <>
            <button
              onClick={() => runPlaybookNow(true)}
              title="Dry-run this playbook over SSH — shows what WOULD change, no changes made (ansible-playbook --check)"
              data-testid="iac-studio-run-check"
              className="iac-studio-run-check"
            >
              ▷ Dry-run
            </button>
            <button
              onClick={() => runPlaybookNow(false)}
              title="Run this playbook for real over SSH — applies changes to your devices (ansible-playbook)"
              data-testid="iac-studio-run-real"
              className="iac-studio-run-real"
            >
              ▶ Run
            </button>
          </>
        )}
        {canRunTerraform && (
          <>
            <button
              onClick={() => runInTerminal("terraform plan", state.root_path)}
              title="Show what Terraform would change (terraform plan)"
              data-testid="iac-studio-tf-plan"
              className="iac-studio-run-check"
            >
              ▷ Plan
            </button>
            <button
              onClick={() => runInTerminal("terraform apply", state.root_path)}
              title="Apply Terraform changes (terraform apply)"
              data-testid="iac-studio-tf-apply"
              className="iac-studio-run-real"
            >
              ▶ Apply
            </button>
          </>
        )}
        {state.root_path && (
          <button
            onClick={() => setShowPushModal(true)}
            title="Commit this workspace and push to your Git host — this is what triggers a self-hosted CI run"
            data-testid="iac-studio-push"
          >
            ⬆ Push to Git
          </button>
        )}
        {state.root_path && (
          <button
            onClick={() => setShowRunsPanel((v) => !v)}
            title="Show recent GitHub Actions pipeline runs for this repo"
            data-testid="iac-studio-runs"
          >
            ⚙ Runs
          </button>
        )}
        <button
          onClick={onSave}
          disabled={!state.is_dirty || !state.file_path || state.loading}
          title="Save (Cmd+S)"
          data-testid="iac-studio-save"
        >
          Save
        </button>
      </div>

      <div className="iac-studio-main">
        <FileExplorer
          rootPath={state.root_path}
          expandedDirs={state.expanded_dirs}
          onSelectFile={onOpenFile}
          onToggleDir={(dir) => toggleDir(tab.id, dir)}
          refreshKey={treeRefresh}
        />
        <div className="iac-studio-content">
          {state.file_path ? (
            <>
              <EditorActionToolbar
                editor={editorRef.current}
                canSave={Boolean(state.is_dirty && state.file_path && !state.loading)}
                onSave={() => void onSave()}
                onOpenWorkspace={() => void onBrowse()}
                onFind={undefined}
                onWorkspaceFind={undefined}
                onSettings={undefined}
                onProblems={() => {}}
                extraRunActions={(
                  <>
                    {canRunPlaybook && (
                      <>
                        <button
                          type="button"
                          onClick={() => runPlaybookNow(true)}
                          title="Dry-run this playbook over SSH"
                        >
                          ▷ Dry-run
                        </button>
                        <button
                          type="button"
                          onClick={() => runPlaybookNow(false)}
                          title="Run this playbook over SSH"
                        >
                          ▶ Run
                        </button>
                      </>
                    )}
                    {canRunTerraform && (
                      <>
                        <button
                          type="button"
                          onClick={() => runInTerminal("terraform plan", state.root_path)}
                          title="Terraform plan"
                        >
                          ▷ Plan
                        </button>
                        <button
                          type="button"
                          onClick={() => runInTerminal("terraform apply", state.root_path)}
                          title="Terraform apply"
                        >
                          ▶ Apply
                        </button>
                      </>
                    )}
                  </>
                )}
              />
              <MonacoEditor
              value={state.content}
              language={state.language}
              onChange={(c) => setContent(tab.id, c)}
              onCursorChange={(p) => setCursor(tab.id, p.line, p.column)}
              onSave={onSave}
              settings={settings}
              tabId={tab.id}
              filePath={state.file_path}
              workspaceRoot={state.root_path}
              onEditorReady={(editor, monaco) => {
                editorRef.current = editor;
                monacoRef.current = monaco;
                setEditorReady(true);
              }}
            />
            </>
          ) : (
            <div className="iac-studio-empty">
              <p>Select a <code>.tf</code> or <code>.yml</code> file from the tree to begin editing.</p>
              <p className="iac-studio-empty-hint">New to Infrastructure-as-Code?</p>
              <button
                className="iac-studio-getstarted"
                onClick={() => setPendingWizard(tab.id, "onboarding")}
                data-testid="iac-getstarted"
              >
                🚀 Get Started with Pipelines
              </button>
            </div>
          )}
          {showRunsPanel && state.root_path && (
            <GitHubRunsPanel
              rootPath={state.root_path}
              onClose={() => setShowRunsPanel(false)}
            />
          )}
        </div>
        <IacAiPanel
          tabId={tab.id}
          rootPath={state.root_path}
          filePath={state.file_path}
          language={state.language}
          content={state.content}
          generating={state.ai.generating}
          error={state.ai.error}
          onProposal={(p) => setAiProposal(tab.id, p)}
          onGenerating={(g) => setAiGenerating(tab.id, g)}
          onError={(msg) => setAiError(tab.id, msg)}
        />
      </div>

      {state.file_path && (
        <IacProblemsPanel diagnostics={diagnostics} linters={linters} onJumpTo={onJumpTo} />
      )}

      {state.error && (
        <div className="iac-studio-error" data-testid="iac-studio-error">
          {state.error}
        </div>
      )}

      <div className="iac-studio-status">
        <span>Ln {state.cursor.line}, Col {state.cursor.column}</span>
        <span>{state.language}</span>
      </div>

      {showPushModal && state.root_path && (
        <PushToGitModal
          rootPath={state.root_path}
          onClose={() => setShowPushModal(false)}
        />
      )}

      {state.ai.proposal && (
        <IacDiffPreview
          original={state.content}
          proposal={state.ai.proposal}
          language={state.language}
          onAccept={onAcceptProposal}
          onReject={() => { clearAiProposal(tab.id); advanceQueue(); }}
        />
      )}

      {/* New Resource / New Pipeline: show the chooser first (create vs edit/
          delete existing); "Create new" flips creatingNew → the gen wizard. */}
      {(state.pending_wizard === "resource" || state.pending_wizard === "pipeline") &&
        !state.ai.proposal &&
        !creatingNew && (
          <IacFileChooser
            kind={state.pending_wizard}
            rootPath={state.root_path}
            onCreateNew={() => setCreatingNew(true)}
            onEdit={(filePath) => {
              setPendingWizard(tab.id, null);
              void onOpenFile(filePath);
            }}
            onClose={() => setPendingWizard(tab.id, null)}
          />
        )}

      {state.pending_wizard === "resource" && !state.ai.proposal && creatingNew && (
        <IacResourceWizard
          rootPath={state.root_path}
          onProposal={(p) => setAiProposal(tab.id, p)}
          onClose={() => setPendingWizard(tab.id, null)}
        />
      )}
      {state.pending_wizard === "pipeline" && !state.ai.proposal && creatingNew && (
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
      {state.pending_wizard === "onboarding" && (
        // Stay MOUNTED through the whole flow (hidden, not unmounted) so the
        // wizard's step state survives: diff previews → coach-marks → the final
        // Next-steps checklist (step 6). It closes only when the user clicks Done.
        <PipelineOnboardingWizard
          rootPath={state.root_path}
          hidden={!!state.ai.proposal || !!state.coach?.active}
          onScaffoldProposals={(ps) => {
            // Scaffold may return multiple files (e.g. playbook + inventory);
            // queue them so each is diffed/written one at a time.
            if (ps.length > 0) {
              setPipelineQueue(ps);
              setAiProposal(tab.id, ps[0]);
            }
          }}
          onPipelineProposal={(p) => {
            // Arm coach-marks BEFORE the diff/accept cycle so onAcceptProposal
            // fires the walkthrough once the pipeline file opens. Keep the wizard
            // mounted (don't null pending_wizard) so its step-6 checklist shows
            // after the coach-marks finish.
            setCoachPending(tab.id, true);
            setAiProposal(tab.id, p);
          }}
          onClose={() => setPendingWizard(tab.id, null)}
        />
      )}

      {state.coach?.active && editorReady && editorRef.current && monacoRef.current && (
        <EditorCoachMarks
          editor={editorRef.current}
          monaco={monacoRef.current}
          steps={state.coach.steps}
          index={state.coach.index}
          onNext={() => coachNext(tab.id)}
          onBack={() => coachBack(tab.id)}
          onDismiss={() => coachEnd(tab.id)}
        />
      )}
    </div>
  );
}
