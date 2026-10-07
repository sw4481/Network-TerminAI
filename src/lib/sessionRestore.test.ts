import { describe, it, expect } from "vitest";
import { MANAGED_SSH_SHELL_MARKER, isManagedSshTab, planRestore, reopenedTabShell } from "./sessionRestore";
import { defaultShell } from "./defaultShell";
import type { SessionSnapshot } from "./tauri";

const snap = (tabs: any[], active: string | null): SessionSnapshot => ({
  id: "s", name: "__last__", active_tab_id: active, tabs, created_at: 0,
});

describe("planRestore", () => {
  it("returns empty plan for null snapshot", () => {
    expect(planRestore(null)).toEqual({ tabs: [], activeTabId: null });
  });

  it("keeps terminal tabs (non-empty shell_cmd), drops special tabs", () => {
    const plan = planRestore(snap([
      { id: "t1", title: "zsh", shell_cmd: "/bin/zsh", cwd: "/a", created_at: 1, scrollback: [104, 105], ai_messages: [] },
      { id: "api1", title: "API", shell_cmd: "", cwd: "/", created_at: 2, scrollback: [], ai_messages: [] },
    ], "t1"));
    expect(plan.tabs.map((t) => t.id)).toEqual(["t1"]);
    expect(plan.tabs[0].replayBytes).toEqual([104, 105]);
    expect(plan.activeTabId).toBe("t1");
  });

  it("marks the backend managed SSH shell marker as disconnected-only, keeping local shells restorable", () => {
    const plan = planRestore(snap([
      { id: "ssh", title: "Core", shell_cmd: "terminai:managed-ssh-disconnected", cwd: "/", created_at: 1, scrollback: [65] },
      { id: "local", title: "zsh", shell_cmd: "/bin/zsh", cwd: "/", created_at: 2, scrollback: [] },
    ], "ssh"));
    expect(plan.tabs.map((tab) => tab.managed)).toEqual([true, false]);
    expect(plan.tabs[0].replayBytes).toEqual([65]);
    expect(plan.activeTabId).toBe("ssh");
  });

  it("identifies both persisted managed history and a live managed connection for detach safety", () => {
    expect(isManagedSshTab(MANAGED_SSH_SHELL_MARKER)).toBe(true);
    expect(isManagedSshTab("powershell.exe", true)).toBe(true);
    expect(isManagedSshTab("/bin/zsh", false)).toBe(false);
  });

  it("explicitly reopens managed history as disconnected-only, but local history as a local shell", () => {
    expect(reopenedTabShell(true)).toBe(MANAGED_SSH_SHELL_MARKER);
    expect(reopenedTabShell(false)).toBe(defaultShell());
    expect(reopenedTabShell()).toBe(defaultShell());
  });

  it("clears activeTabId when the active tab was not a terminal", () => {
    const plan = planRestore(snap([
      { id: "t1", title: "zsh", shell_cmd: "/bin/zsh", cwd: "/a", created_at: 1, scrollback: [], ai_messages: [] },
      { id: "api1", title: "API", shell_cmd: "", cwd: "/", created_at: 2, scrollback: [], ai_messages: [] },
    ], "api1"));
    // active falls back to the first restored terminal tab
    expect(plan.activeTabId).toBe("t1");
  });
});
