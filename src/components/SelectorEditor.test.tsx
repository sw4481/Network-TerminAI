import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import type { IntentSelector } from "../lib/drift";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { SelectorEditor } from "./SelectorEditor";

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "fanout_group_list")
      return [
        { id: "g1", name: "site-atl", description: null, created_at: 0, updated_at: 0, member_count: 5 },
        { id: "g2", name: "site-bos", description: null, created_at: 0, updated_at: 0, member_count: 2 },
      ];
    if (cmd === "ssh_list_connections")
      return [
        { id: "c1", name: "core-01", host: "10.0.0.1" },
        { id: "c2", name: "edge-02", host: "10.0.0.2" },
      ];
    return [];
  });
});

const empty: IntentSelector = { device_ids: [], tags: [] };

describe("SelectorEditor", () => {
  it("selecting a fan-out group emits group_id and clears ssh", async () => {
    const onChange = vi.fn();
    render(<SelectorEditor value={empty} onChange={onChange} />);

    // Choose the group mode + pick a group.
    fireEvent.click(await screen.findByTestId("selector-mode-group"));
    const groupSelect = await screen.findByTestId("selector-group-select");
    fireEvent.change(groupSelect, { target: { value: "g1" } });

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ group_id: "g1", ssh_connection_id: null }),
      ),
    );
  });

  it("selecting an SSH connection emits ssh_connection_id and clears group", async () => {
    const onChange = vi.fn();
    render(<SelectorEditor value={empty} onChange={onChange} />);

    fireEvent.click(await screen.findByTestId("selector-mode-ssh"));
    const sshSelect = await screen.findByTestId("selector-ssh-select");
    fireEvent.change(sshSelect, { target: { value: "c2" } });

    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith(
        expect.objectContaining({ ssh_connection_id: "c2", group_id: null }),
      ),
    );
  });

  it("pre-selects the group mode when value already has a group_id", async () => {
    const onChange = vi.fn();
    render(
      <SelectorEditor
        value={{ ...empty, group_id: "g2" }}
        onChange={onChange}
      />,
    );
    const groupSelect = await screen.findByTestId("selector-group-select");
    expect((groupSelect as HTMLSelectElement).value).toBe("g2");
  });

  it("loads groups and connections from the backend", async () => {
    render(<SelectorEditor value={empty} onChange={vi.fn()} />);
    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith("fanout_group_list");
      expect(invokeMock).toHaveBeenCalledWith("ssh_list_connections");
    });
  });
});
