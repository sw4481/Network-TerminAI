/**
 * IaC Studio Phase A — IacStudioTab render tests.
 *
 * Regression guard: the component must render on its very FIRST render even
 * though the store entry for the tab does not exist yet (it is seeded by a
 * useEffect that runs AFTER the first render). A prior version dereferenced
 * `state.file_path` inside useCallback dependency arrays, which React
 * evaluates during render — crashing with "undefined is not an object
 * (evaluating 'state.file_path')" before the `if (!state) return null` guard
 * could take effect.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { Tab } from "../../lib/types";
import { useIacStudioStore } from "../../state/iacStudioStore";

const mocks = vi.hoisted(() => ({
  editor: {
    focus: vi.fn(),
    trigger: vi.fn(),
    getAction: vi.fn(() => ({ run: vi.fn() })),
    getModel: vi.fn(() => ({})),
  },
  monaco: {
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2 },
    editor: { setModelMarkers: vi.fn() },
  },
}));

// Tauri command bindings — never invoked in these render tests, but the
// module imports them, so stub to keep jsdom happy.
vi.mock("../../lib/tauri", () => ({
  iacStudioReadFile: vi.fn(),
  iacStudioWriteFile: vi.fn(),
  iacLintFile: vi.fn(),
  editorListDirectory: vi.fn().mockResolvedValue([]),
}));

// FileExplorer calls editorListDirectory on mount; stub the whole component
// to a sentinel so we test IacStudioTab in isolation.
vi.mock("../editor/FileExplorer", () => ({
  FileExplorer: () => <div data-testid="file-explorer" />,
}));

// MonacoEditor lazy-loads monaco (never resolves under jsdom); stub it.
// useEditorSettings imports DEFAULT_EDITOR_SETTINGS from this module, so the
// mock must re-export it.
vi.mock("../editor/MonacoEditor", () => ({
  MonacoEditor: (props: { onEditorReady?: (editor: unknown, monaco: unknown) => void }) => {
    props.onEditorReady?.(mocks.editor, mocks.monaco);
    return <div data-testid="monaco" />;
  },
  DEFAULT_EDITOR_SETTINGS: {
    fontSize: 14,
    tabSize: 2,
    wordWrap: "on",
    minimap: true,
    lineNumbers: true,
    renderWhitespace: false,
  },
}));

// IacAiPanel makes Tauri calls on generate; stub to a sentinel.
vi.mock("./IacAiPanel", () => ({
  IacAiPanel: () => <div data-testid="iac-ai-panel" />,
}));

// IacDiffPreview renders Monaco; stub so the overlay never loads real monaco.
vi.mock("./IacDiffPreview", () => ({
  IacDiffPreview: ({ onAccept }: { onAccept: () => void }) => (
    <div data-testid="iac-diff-preview">
      <button data-testid="iac-diff-accept" onClick={onAccept}>Accept</button>
    </div>
  ),
}));

// Wizard components — stub to prevent real RPC calls.
vi.mock("./IacResourceWizard", () => ({ IacResourceWizard: () => <div data-testid="iac-resource-wizard" /> }));
vi.mock("./IacPipelineWizard", () => ({ IacPipelineWizard: () => <div data-testid="iac-pipeline-wizard" /> }));

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "iac-tab-1",
    title: "IaC Studio",
    shell_cmd: "",
    cwd: "/tmp/project",
    created_at: 0,
    tab_type: "iac-studio",
    ...overrides,
  };
}

describe("IacStudioTab", () => {
  beforeEach(() => {
    // Start every test with an EMPTY store — this is the first-render
    // condition that reproduced the crash.
    useIacStudioStore.setState({ tabs: {} });
  });

  it("renders without crashing when the store has no entry yet (first render)", async () => {
    const { IacStudioTab } = await import("./IacStudioTab");
    const tab = makeTab();
    // Must not throw "undefined is not an object (evaluating 'state.file_path')".
    expect(() => render(<IacStudioTab tab={tab} />)).not.toThrow();
  });

  it("seeds the store rooted at the tab cwd and shows the empty state", async () => {
    const { IacStudioTab } = await import("./IacStudioTab");
    const tab = makeTab({ cwd: "/tmp/project" });
    render(<IacStudioTab tab={tab} />);

    // The effect seeds the store; the workspace path is shown in the toolbar.
    expect(await screen.findByText("/tmp/project")).toBeInTheDocument();
    // No file open yet → empty-state prompt, not the editor.
    expect(screen.getByTestId("iac-studio-tab")).toBeInTheDocument();
    expect(screen.queryByTestId("monaco")).not.toBeInTheDocument();
    expect(useIacStudioStore.getState().tabs[tab.id]?.root_path).toBe("/tmp/project");
  });

  it("renders the AI panel as the right pane", async () => {
    const { IacStudioTab } = await import("./IacStudioTab");
    render(<IacStudioTab tab={makeTab()} />);
    expect(screen.getByTestId("iac-ai-panel")).toBeInTheDocument();
  });

  it("falls back to '.' when the tab cwd is '/' or empty", async () => {
    const { IacStudioTab } = await import("./IacStudioTab");
    const tab = makeTab({ id: "iac-tab-2", cwd: "/" });
    render(<IacStudioTab tab={tab} />);
    expect(useIacStudioStore.getState().tabs["iac-tab-2"]?.root_path).toBe(".");
  });

  it("renders the Problems panel with diagnostics once a file is open", async () => {
    const tauri = await import("../../lib/tauri");
    (tauri.iacLintFile as ReturnType<typeof vi.fn>).mockResolvedValue({
      diagnostics: [
        { line: 1, column: 1, severity: "error", message: "boom", source: "terraform fmt" },
      ],
      linters: [{ name: "terraform fmt", ran: true, available: true, reason: null }],
    });

    const { IacStudioTab } = await import("./IacStudioTab");
    const tab = makeTab({ id: "iac-lint-tab", cwd: "/tmp/project" });

    // Seed the store with an OPEN file so the editor + panel render (FileExplorer
    // is stubbed, so we can't open a file through the UI).
    const { ensure, openFile } = useIacStudioStore.getState();
    ensure(tab.id, "/tmp/project");
    openFile(tab.id, "/tmp/project/main.tf", "locals { x = }", "hcl");

    render(<IacStudioTab tab={tab} />);

    // The Problems panel appears, and the debounced lint result shows up.
    expect(await screen.findByTestId("iac-studio-problems")).toBeInTheDocument();
    expect(await screen.findByText(/boom/)).toBeInTheDocument();
  });

  it("accepting a proposal with target_path writes a new file", async () => {
    const tauri = await import("../../lib/tauri");
    const writeSpy = tauri.iacStudioWriteFile as ReturnType<typeof vi.fn>;
    writeSpy.mockClear();
    writeSpy.mockResolvedValue(undefined);

    const { IacStudioTab } = await import("./IacStudioTab");
    const tab = makeTab({ id: "iac-write-tab", cwd: "/root" });
    const { ensure, setAiProposal } = useIacStudioStore.getState();
    ensure(tab.id, "/root");
    setAiProposal(tab.id, {
      code: 'resource "x" {}',
      filename: "web.tf",
      explanation: "",
      target_path: "/root/web.tf",
      validation: { valid: null, skipped: true, error: null },
    });

    render(<IacStudioTab tab={tab} />);
    fireEvent.click(screen.getByTestId("iac-diff-accept"));

    await waitFor(() =>
      expect(writeSpy).toHaveBeenCalledWith("/root/web.tf", 'resource "x" {}', "/root"),
    );
  });

  it("accepting a proposal WITHOUT target_path edits the buffer (Phase C path)", async () => {
    const tauri = await import("../../lib/tauri");
    const writeSpy = tauri.iacStudioWriteFile as ReturnType<typeof vi.fn>;
    writeSpy.mockClear();

    const { IacStudioTab } = await import("./IacStudioTab");
    const tab = makeTab({ id: "iac-buf-tab", cwd: "/root" });
    const { ensure, openFile, setAiProposal } = useIacStudioStore.getState();
    ensure(tab.id, "/root");
    openFile(tab.id, "/root/main.tf", "old", "hcl");
    setAiProposal(tab.id, {
      code: "new content",
      filename: "main.tf",
      explanation: "",
      validation: { valid: null, skipped: true, error: null },
    });

    render(<IacStudioTab tab={tab} />);
    fireEvent.click(screen.getByTestId("iac-diff-accept"));

    await waitFor(() =>
      expect(useIacStudioStore.getState().tabs[tab.id].content).toBe("new content"),
    );
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it("shows direct-SSH Run buttons only for an open Ansible playbook, not for .tf", async () => {
    const { IacStudioTab } = await import("./IacStudioTab");

    // .tf file → no run buttons.
    const tfTab = makeTab({ id: "iac-run-tf", cwd: "/root" });
    useIacStudioStore.getState().ensure(tfTab.id, "/root");
    useIacStudioStore.getState().openFile(tfTab.id, "/root/main.tf", "x", "hcl");
    const { unmount } = render(<IacStudioTab tab={tfTab} />);
    expect(screen.queryByTestId("iac-studio-run-check")).toBeNull();
    unmount();

    // playbook.yml → dry-run + run buttons appear.
    const ymlTab = makeTab({ id: "iac-run-yml", cwd: "/root" });
    useIacStudioStore.getState().ensure(ymlTab.id, "/root");
    useIacStudioStore.getState().openFile(ymlTab.id, "/root/playbook.yml", "- hosts: all", "yaml");
    render(<IacStudioTab tab={ymlTab} />);
    expect(screen.getByTestId("iac-studio-run-check")).toBeTruthy();
    expect(screen.getByTestId("iac-studio-run-real")).toBeTruthy();
  });

  it("clicking Dry-run dispatches ansible-playbook --check via ccie:run-in-terminal", async () => {
    const tauri = await import("../../lib/tauri");
    (tauri.editorListDirectory as ReturnType<typeof vi.fn>).mockResolvedValue([
      { path: "/root/inventory.ini", name: "inventory.ini", node_type: "file" },
    ]);
    const events: CustomEvent[] = [];
    const handler = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener("ccie:run-in-terminal", handler);
    try {
      const { IacStudioTab } = await import("./IacStudioTab");
      const tab = makeTab({ id: "iac-run-dispatch", cwd: "/root" });
      useIacStudioStore.getState().ensure(tab.id, "/root");
      useIacStudioStore.getState().openFile(tab.id, "/root/playbook.yml", "- hosts: all", "yaml");
      render(<IacStudioTab tab={tab} />);

      fireEvent.click(screen.getByTestId("iac-studio-run-check"));
      await waitFor(() => expect(events).toHaveLength(1));
      expect(events[0].detail.command).toBe(
        "ansible-playbook -i inventory.ini playbook.yml --check",
      );
      expect(events[0].detail.cwd).toBe("/root");
    } finally {
      window.removeEventListener("ccie:run-in-terminal", handler);
    }
  });

  it("renders the shared editor action toolbar for open IaC files", async () => {
    const { IacStudioTab } = await import("./IacStudioTab");
    const tab = makeTab({ id: "iac-toolbar-tab", cwd: "/root" });
    useIacStudioStore.getState().ensure(tab.id, "/root");
    useIacStudioStore.getState().openFile(tab.id, "/root/main.tf", "resource x", "hcl");

    render(<IacStudioTab tab={tab} />);

    expect(screen.getByRole("toolbar", { name: "Editor actions" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Format document" }));
    expect(mocks.editor.getAction).toHaveBeenCalledWith("editor.action.formatDocument");
  });
});
