import { describe, it, expect, vi, beforeEach } from "vitest";

// Hoisted mock that the store will pick up when it imports tauri.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { useFanoutStore } from "./fanoutStore";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockInvoke.mockReset();
  // Reset store between tests
  useFanoutStore.setState({
    groups: [],
    membersByGroup: {},
    loading: false,
    error: null,
  });
});

describe("fanoutStore", () => {
  it("creates a group and adds it to state", async () => {
    mockInvoke.mockImplementation(async (cmd: string, _args: unknown) => {
      if (cmd === "fanout_group_create") {
        return {
          id: "g1",
          name: "atl",
          description: null,
          created_at: 0,
          updated_at: 0,
          member_count: 0,
        };
      }
      throw new Error("unexpected " + cmd);
    });
    await useFanoutStore.getState().createGroup("atl", null);
    expect(useFanoutStore.getState().groups[0].name).toBe("atl");
  });

  it("loads groups from backend", async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fanout_group_list") {
        return [
          {
            id: "g1",
            name: "atl",
            description: null,
            created_at: 0,
            updated_at: 0,
            member_count: 3,
          },
        ];
      }
      throw new Error("unexpected " + cmd);
    });
    await useFanoutStore.getState().refreshGroups();
    expect(useFanoutStore.getState().groups[0].member_count).toBe(3);
    expect(useFanoutStore.getState().loading).toBe(false);
  });

  it("removes a deleted group", async () => {
    useFanoutStore.setState({
      groups: [
        {
          id: "g1",
          name: "x",
          description: null,
          created_at: 0,
          updated_at: 0,
          member_count: 0,
        },
      ],
    });
    mockInvoke.mockResolvedValue(undefined);
    await useFanoutStore.getState().deleteGroup("g1");
    expect(useFanoutStore.getState().groups).toHaveLength(0);
  });

  it("captures error on backend failure", async () => {
    mockInvoke.mockRejectedValue("boom");
    await useFanoutStore.getState().refreshGroups();
    expect(useFanoutStore.getState().error).toContain("boom");
    expect(useFanoutStore.getState().loading).toBe(false);
  });

  it("removes a member optimistically", async () => {
    useFanoutStore.setState({
      groups: [
        {
          id: "g1",
          name: "x",
          description: null,
          created_at: 0,
          updated_at: 0,
          member_count: 1,
        },
      ],
      membersByGroup: {
        g1: [
          {
            device_id: "d1",
            device_kind: "ssh",
            display_name: "r1",
            host: "10.0.0.1",
            added_at: 0,
          },
        ],
      },
    });
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === "fanout_member_remove") return undefined;
      if (cmd === "fanout_group_list") return [];
      throw new Error("unexpected " + cmd);
    });
    await useFanoutStore.getState().removeMember("g1", "d1", "ssh");
    expect(useFanoutStore.getState().membersByGroup.g1).toHaveLength(0);
  });
});
