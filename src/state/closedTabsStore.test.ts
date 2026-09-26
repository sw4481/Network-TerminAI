import { describe, it, expect, beforeEach } from "vitest";
import { useClosedTabs } from "./closedTabsStore";

const reset = () => useClosedTabs.setState({ items: [] });

describe("closedTabsStore", () => {
  beforeEach(reset);

  it("push prepends newest-first and popMostRecent returns/removes it", () => {
    useClosedTabs.getState().push({ id: "a", title: "A", cwd: "/", closedAt: 1 });
    useClosedTabs.getState().push({ id: "b", title: "B", cwd: "/", closedAt: 2 });
    expect(useClosedTabs.getState().items.map((t) => t.id)).toEqual(["b", "a"]);
    expect(useClosedTabs.getState().popMostRecent()?.id).toBe("b");
    expect(useClosedTabs.getState().items.map((t) => t.id)).toEqual(["a"]);
  });

  it("popMostRecent returns null when empty", () => {
    expect(useClosedTabs.getState().popMostRecent()).toBeNull();
  });

  it("caps at 25 entries, dropping the oldest", () => {
    for (let i = 0; i < 30; i++) {
      useClosedTabs.getState().push({ id: String(i), title: String(i), cwd: "/", closedAt: i });
    }
    const items = useClosedTabs.getState().items;
    expect(items.length).toBe(25);
    expect(items[0].id).toBe("29"); // newest
    expect(items.at(-1)?.id).toBe("5"); // oldest kept
  });

  it("removeById drops a specific entry", () => {
    useClosedTabs.getState().push({ id: "a", title: "A", cwd: "/", closedAt: 1 });
    useClosedTabs.getState().push({ id: "b", title: "B", cwd: "/", closedAt: 2 });
    useClosedTabs.getState().removeById("a");
    expect(useClosedTabs.getState().items.map((t) => t.id)).toEqual(["b"]);
  });
});
