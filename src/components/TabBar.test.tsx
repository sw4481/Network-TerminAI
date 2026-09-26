/**
 * TabBar regression + tab-type tests.
 *
 * Regression-critical invariants (Phase 1 → Phase 2 API Runner):
 *   1. "+ New" default action still creates a Terminal tab (backward compat).
 *   2. "+ API" button exists when `onNewApi` is provided.
 *   3. Closing a terminal tab disposes the registry session (PTY path; with
 *      ENABLE_TERMINAL_REGISTRY on, via terminalRegistry.dispose).
 *   4. Closing an API tab calls `tabCloseApi` (NOT `ptyKill`).
 *   5. API tabs render with a visible badge so users can tell them apart.
 *   6. Mixed terminal + API tabs render in the right order.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { TabBar } from "./TabBar";
import { useTabs } from "../state/tabsStore";
import { useEditorStore } from "../state/editorStore";

// Mock the Tauri IPC wrappers so we can assert on them.
vi.mock("../lib/tauri", () => ({
  ptyKill: vi.fn().mockResolvedValue(undefined),
  tabCloseApi: vi.fn().mockResolvedValue(undefined),
  tabCloseNetconf: vi.fn().mockResolvedValue(undefined),
  tabCloseEditor: vi.fn().mockResolvedValue(undefined),
}));
import { ptyKill, tabCloseApi, tabCloseEditor } from "../lib/tauri";

// With ENABLE_TERMINAL_REGISTRY on, closing a terminal tab routes through
// terminalRegistry.dispose() (which kills the PTY + xterm) instead of the
// legacy ptyKill. Mock the registry so we can assert on dispose.
vi.mock("../lib/terminalRegistry", () => ({
  dispose: vi.fn(),
  // tab-dot derivation resolves each pane's terminalId → spawned PTY id;
  // return null so the mock falls back to the raw id (fine for these tests).
  ptyTabIdFor: vi.fn(() => null),
}));
import * as terminalRegistry from "../lib/terminalRegistry";

function resetStore() {
  act(() => {
    useTabs.setState({
      tabs: [],
      activeTabId: null,
      blocks: {},
    });
    useEditorStore.getState().resetAll();
  });
}

describe("TabBar — regression + tab types", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it("renders the '+' button and calls onNew (Terminal path, backward compat)", () => {
    const onNew = vi.fn();
    render(<TabBar onNew={onNew} />);
    const btn = screen.getByTitle("New terminal tab");
    fireEvent.click(btn);
    expect(onNew).toHaveBeenCalledOnce();
  });

  it("exposes the detach action for terminal tabs", () => {
    const tab = {
      id: "t1",
      title: "zsh",
      shell_cmd: "/bin/zsh",
      cwd: "/",
      created_at: 0,
      tab_type: "terminal" as const,
    };
    act(() => {
      useTabs.setState({ tabs: [tab], activeTabId: tab.id, blocks: {} });
    });
    const onDetach = vi.fn();
    render(<TabBar onNew={() => {}} onDetach={onDetach} />);
    fireEvent.click(screen.getByLabelText("Detach zsh"));
    expect(onDetach).toHaveBeenCalledWith(tab);
  });

  it("does NOT render '+ API' button when onNewApi prop is absent", () => {
    render(<TabBar onNew={() => {}} />);
    expect(screen.queryByTestId("tab-new-api")).toBeNull();
  });

  it("renders '+ API' button when onNewApi is provided", () => {
    const onNewApi = vi.fn();
    render(<TabBar onNew={() => {}} onNewApi={onNewApi} />);
    const apiBtn = screen.getByTestId("tab-new-api");
    fireEvent.click(apiBtn);
    expect(onNewApi).toHaveBeenCalledOnce();
  });

  it("closing a terminal tab disposes the registry session (not tabCloseApi)", async () => {
    act(() => {
      useTabs.setState({
        tabs: [
          {
            id: "t1",
            title: "zsh",
            shell_cmd: "/bin/zsh",
            cwd: "/",
            created_at: 0,
            tab_type: "terminal",
          },
        ],
        activeTabId: "t1",
        blocks: {},
      });
    });
    render(<TabBar onNew={() => {}} />);
    const close = screen
      .getByTestId("tab-t1")
      .querySelector(".tab-close") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(close);
    });
    // ENABLE_TERMINAL_REGISTRY is on: terminal-tab close routes through
    // terminalRegistry.dispose (kills PTY + xterm), NOT the legacy ptyKill.
    expect(terminalRegistry.dispose).toHaveBeenCalledWith("t1");
    expect(ptyKill).not.toHaveBeenCalled();
    expect(tabCloseApi).not.toHaveBeenCalled();
  });

  it("closing an API tab calls tabCloseApi (not ptyKill) — regression guard", async () => {
    act(() => {
      useTabs.setState({
        tabs: [
          {
            id: "api-1",
            title: "API 1",
            shell_cmd: "",
            cwd: "",
            created_at: 0,
            tab_type: "api",
          },
        ],
        activeTabId: "api-1",
        blocks: {},
      });
    });
    render(<TabBar onNew={() => {}} />);
    const close = screen
      .getByTestId("tab-api-1")
      .querySelector(".tab-close") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(close);
    });
    expect(tabCloseApi).toHaveBeenCalledWith("api-1");
    expect(ptyKill).not.toHaveBeenCalled();
  });

  it("closes native editor windows before dropping the editor workspace", async () => {
    act(() => {
      useTabs.setState({
        tabs: [
          {
            id: "editor-1",
            title: "Editor",
            shell_cmd: "",
            cwd: "",
            created_at: 0,
            tab_type: "editor",
          },
        ],
        activeTabId: "editor-1",
        blocks: {},
      });
      useEditorStore.getState().initializeWorkspace("editor-1");
    });
    render(<TabBar onNew={() => {}} />);

    const close = screen
      .getByTestId("tab-editor-1")
      .querySelector(".tab-close") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(close);
      await Promise.resolve();
    });

    expect(tabCloseEditor).toHaveBeenCalledWith("editor-1");
    expect(useTabs.getState().tabs).toHaveLength(0);
    expect(useEditorStore.getState().workspaces["editor-1"]).toBeUndefined();
  });

  it("keeps an editor tab and workspace when native-window cleanup fails", async () => {
    vi.mocked(tabCloseEditor).mockRejectedValueOnce(
      new Error("window close failed"),
    );
    act(() => {
      useTabs.setState({
        tabs: [
          {
            id: "editor-1",
            title: "Editor",
            shell_cmd: "",
            cwd: "",
            created_at: 0,
            tab_type: "editor",
          },
        ],
        activeTabId: "editor-1",
        blocks: {},
      });
      useEditorStore.getState().initializeWorkspace("editor-1");
    });
    render(<TabBar onNew={() => {}} />);

    const close = screen
      .getByTestId("tab-editor-1")
      .querySelector(".tab-close") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(close);
      await Promise.resolve();
    });

    expect(useTabs.getState().tabs).toHaveLength(1);
    expect(useEditorStore.getState().workspaces["editor-1"].error).toContain(
      "window close failed",
    );
  });

  it("API tabs render with an 'API' badge; terminal tabs do not", () => {
    act(() => {
      useTabs.setState({
        tabs: [
          {
            id: "t1",
            title: "zsh",
            shell_cmd: "/bin/zsh",
            cwd: "/",
            created_at: 0,
            tab_type: "terminal",
          },
          {
            id: "a1",
            title: "API 1",
            shell_cmd: "",
            cwd: "",
            created_at: 1,
            tab_type: "api",
          },
        ],
        activeTabId: "t1",
        blocks: {},
      });
    });
    render(<TabBar onNew={() => {}} />);
    const termTab = screen.getByTestId("tab-t1");
    const apiTab = screen.getByTestId("tab-a1");
    expect(termTab.querySelector(".tab-type-badge")).toBeNull();
    expect(apiTab.querySelector(".tab-type-badge")?.textContent).toBe("API");
  });

  it("mixed terminal + API tabs render in insertion order", () => {
    act(() => {
      useTabs.setState({
        tabs: [
          {
            id: "t1",
            title: "zsh",
            shell_cmd: "/bin/zsh",
            cwd: "/",
            created_at: 0,
            tab_type: "terminal",
          },
          {
            id: "a1",
            title: "API 1",
            shell_cmd: "",
            cwd: "",
            created_at: 1,
            tab_type: "api",
          },
          {
            id: "t2",
            title: "bash",
            shell_cmd: "/bin/bash",
            cwd: "/",
            created_at: 2,
            tab_type: "terminal",
          },
        ],
        activeTabId: "t1",
        blocks: {},
      });
    });
    render(<TabBar onNew={() => {}} />);
    const rendered = Array.from(
      document.querySelectorAll("[data-testid^='tab-']"),
    ).map((el) => (el as HTMLElement).dataset.testid);
    expect(rendered).toEqual(["tab-t1", "tab-a1", "tab-t2"]);
  });

  it("tabs default to 'terminal' type when tab_type is absent (pre-V0013 data)", () => {
    act(() => {
      useTabs.setState({
        tabs: [
          {
            // No tab_type field — simulates a legacy snapshot.
            id: "legacy",
            title: "old",
            shell_cmd: "/bin/zsh",
            cwd: "/",
            created_at: 0,
          },
        ],
        activeTabId: "legacy",
        blocks: {},
      });
    });
    render(<TabBar onNew={() => {}} />);
    const tab = screen.getByTestId("tab-legacy");
    expect(tab.dataset.tabType).toBe("terminal");
    // No API badge should appear.
    expect(tab.querySelector(".tab-type-badge")).toBeNull();
  });
});
