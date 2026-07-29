import { describe, it, expect } from "vitest";
import { planRestore } from "./sessionRestore";
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

  it("clears activeTabId when the active tab was not a terminal", () => {
    const plan = planRestore(snap([
      { id: "t1", title: "zsh", shell_cmd: "/bin/zsh", cwd: "/a", created_at: 1, scrollback: [], ai_messages: [] },
      { id: "api1", title: "API", shell_cmd: "", cwd: "/", created_at: 2, scrollback: [], ai_messages: [] },
    ], "api1"));
    // active falls back to the first restored terminal tab
    expect(plan.activeTabId).toBe("t1");
  });
});
