import { describe, it, expect, beforeEach } from "vitest";
import { useTabs } from "./tabsStore";
import { useClosedTabs } from "./closedTabsStore";
import type { Tab } from "../lib/types";

const tabA: Tab = {
  id: "a",
  title: "A",
  shell_cmd: "/bin/zsh",
  cwd: "/tmp",
  created_at: 0,
};
const tabB: Tab = { ...tabA, id: "b", title: "B" };

beforeEach(() => {
  useTabs.setState({ tabs: [tabA, tabB], activeTabId: "a", blocks: {} });
});

describe("tabsStore.setTabVendor", () => {
  it("updates the targeted tab's vendor + platform", () => {
    useTabs.getState().setTabVendor("a", "cisco", "iosxe");
    const tabs = useTabs.getState().tabs;
    expect(tabs.find((t) => t.id === "a")?.vendor).toBe("cisco");
    expect(tabs.find((t) => t.id === "a")?.platform).toBe("iosxe");
    // Other tab untouched.
    expect(tabs.find((t) => t.id === "b")?.vendor).toBeUndefined();
  });

  it("is a no-op for an unknown tab id", () => {
    useTabs.getState().setTabVendor("nope", "cisco", "iosxe");
    const tabs = useTabs.getState().tabs;
    expect(tabs.find((t) => t.id === "a")?.vendor).toBeUndefined();
  });
});

it("addTab is idempotent on id (no duplicate on double-mount)", () => {
  useTabs.setState({ tabs: [], activeTabId: null });
  const tab = { id: "dup", title: "t", shell_cmd: "zsh", cwd: "/", created_at: 1, tab_type: "terminal" as const };
  useTabs.getState().addTab(tab);
  useTabs.getState().addTab(tab);
  expect(useTabs.getState().tabs.filter((t) => t.id === "dup").length).toBe(1);
});

it("removeTab records terminal tabs to the closed-tabs stack", () => {
  useClosedTabs.setState({ items: [] });
  useTabs.setState({
    tabs: [{ id: "x", title: "SSH r1", shell_cmd: "zsh", cwd: "/cfg", created_at: 1, tab_type: "terminal" }],
    activeTabId: "x",
  });
  useTabs.getState().removeTab("x");
  const items = useClosedTabs.getState().items;
  expect(items.length).toBe(1);
  expect(items[0]).toMatchObject({ id: "x", title: "SSH r1", cwd: "/cfg" });
});

it("removeTab does NOT record non-terminal tabs", () => {
  useClosedTabs.setState({ items: [] });
  useTabs.setState({
    tabs: [{ id: "hb", title: "Heartbeat", shell_cmd: "", cwd: "/", created_at: 1, tab_type: "heartbeat" }],
    activeTabId: "hb",
  });
  useTabs.getState().removeTab("hb");
  expect(useClosedTabs.getState().items.length).toBe(0);
});
