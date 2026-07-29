import { create } from "zustand";
import * as api from "../lib/fanout";
import type { DeviceKind, FanoutGroup, FanoutMember } from "../lib/fanout";

interface FanoutGroupsState {
  groups: FanoutGroup[];
  membersByGroup: Record<string, FanoutMember[]>;
  loading: boolean;
  error: string | null;

  refreshGroups: () => Promise<void>;
  refreshMembers: (groupId: string) => Promise<void>;
  createGroup: (
    name: string,
    description: string | null,
  ) => Promise<FanoutGroup>;
  updateGroup: (
    id: string,
    patch: { name?: string; description?: string | null },
  ) => Promise<void>;
  deleteGroup: (id: string) => Promise<void>;
  addMember: (
    groupId: string,
    deviceId: string,
    kind: DeviceKind,
  ) => Promise<void>;
  addMembersBulk: (
    groupId: string,
    members: Array<{ deviceId: string; kind: DeviceKind }>,
  ) => Promise<number>;
  removeMember: (
    groupId: string,
    deviceId: string,
    kind: DeviceKind,
  ) => Promise<void>;
  importCsv: (
    groupId: string,
    csvBody: string,
  ) => Promise<{ added: number; warnings: string[] }>;
}

export const useFanoutStore = create<FanoutGroupsState>((set, get) => ({
  groups: [],
  membersByGroup: {},
  loading: false,
  error: null,

  refreshGroups: async () => {
    set({ loading: true, error: null });
    try {
      const groups = await api.fanoutGroupList();
      set({ groups, loading: false });
    } catch (e) {
      set({ error: String(e), loading: false });
    }
  },

  refreshMembers: async (groupId) => {
    try {
      const members = await api.fanoutMemberList(groupId);
      set((s) => ({
        membersByGroup: { ...s.membersByGroup, [groupId]: members },
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  createGroup: async (name, description) => {
    const g = await api.fanoutGroupCreate(name, description);
    set((s) => ({ groups: [...s.groups, g] }));
    return g;
  },

  updateGroup: async (id, patch) => {
    const updated = await api.fanoutGroupUpdate(id, patch);
    set((s) => ({
      groups: s.groups.map((g) => (g.id === id ? updated : g)),
    }));
  },

  deleteGroup: async (id) => {
    await api.fanoutGroupDelete(id);
    set((s) => {
      const { [id]: _gone, ...rest } = s.membersByGroup;
      return {
        groups: s.groups.filter((g) => g.id !== id),
        membersByGroup: rest,
      };
    });
  },

  addMember: async (groupId, deviceId, kind) => {
    await api.fanoutMemberAdd(groupId, deviceId, kind);
    await get().refreshMembers(groupId);
    await get().refreshGroups();
  },

  addMembersBulk: async (groupId, members) => {
    const added = await api.fanoutMemberAddBulk(groupId, members);
    await get().refreshMembers(groupId);
    await get().refreshGroups();
    return added;
  },

  removeMember: async (groupId, deviceId, kind) => {
    await api.fanoutMemberRemove(groupId, deviceId, kind);
    set((s) => ({
      membersByGroup: {
        ...s.membersByGroup,
        [groupId]: (s.membersByGroup[groupId] ?? []).filter(
          (m) => !(m.device_id === deviceId && m.device_kind === kind),
        ),
      },
    }));
    await get().refreshGroups();
  },

  importCsv: async (groupId, csvBody) => {
    const result = await api.fanoutGroupImportCsv(groupId, csvBody);
    await get().refreshMembers(groupId);
    await get().refreshGroups();
    return result;
  },
}));
