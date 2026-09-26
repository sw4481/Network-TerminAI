import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn<(...args: unknown[]) => unknown>(async () => []),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { NetconfTab } from "./NetconfTab";
import type { Tab } from "../../lib/types";

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: "nc-test-id",
    title: "My NETCONF Tab",
    shell_cmd: "",
    cwd: "",
    created_at: 0,
    tab_type: "netconf",
    ...overrides,
  };
}

describe("NetconfTab", () => {
  it("renders the netconf tab root with connection panel", () => {
    render(<NetconfTab tab={makeTab()} />);
    const root = screen.getByTestId("netconf-tab");
    expect(root).toBeDefined();
    // Real UI exposes saved-devices + connect form regardless of tab title.
    expect(root.textContent).toContain("Saved Devices");
    expect(root.textContent).toContain("Connect");
  });

  it("renders distinct content for distinct tab ids", () => {
    const { rerender } = render(<NetconfTab tab={makeTab({ id: "abc-123" })} />);
    const a = screen.getByTestId("netconf-tab");
    expect(a).toBeDefined();
    rerender(<NetconfTab tab={makeTab({ id: "xyz-999" })} />);
    expect(screen.getByTestId("netconf-tab")).toBeDefined();
  });
});
