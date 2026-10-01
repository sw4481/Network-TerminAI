import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type KanbanTask = {
  id: string;
  title: string;
  details: string;
  paneContext: string | null;
  completionMode: "autonomous" | "human_review";
  status: "ready" | "running" | "blocked" | "review" | "done" | "cancelled";
  assignedAgent: string | null;
  result: string | null;
  createdAt: number;
  updatedAt: number;
};

export type KanbanActivity = {
  id: string;
  taskId: string;
  runId: string | null;
  kind: string;
  message: string;
  metadata: Record<string, unknown>;
  createdAt: number;
};

export type KanbanTaskDetail = {
  task: KanbanTask;
  runs: { id: string; attempt: number; status: string; startedAt: number; finishedAt: number | null; error: string | null }[];
  activity: KanbanActivity[];
};

type Store = {
  tasks: KanbanTask[];
  selected: KanbanTaskDetail | null;
  load: () => Promise<void>;
  inspect: (id: string) => Promise<void>;
  create: (title: string, details: string, completionMode: KanbanTask["completionMode"], paneContext?: string) => Promise<void>;
  stop: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  approve: (id: string) => Promise<void>;
  subscribe: () => Promise<() => void>;
};

export const useKanbanStore = create<Store>((set, get) => ({
  tasks: [],
  selected: null,
  load: async () => set({ tasks: await invoke<KanbanTask[]>("kanban_list") }),
  inspect: async (id) => set({ selected: await invoke<KanbanTaskDetail>("kanban_get", { id }) }),
  create: async (title, details, completionMode, paneContext) => {
    await invoke("kanban_create", { input: { title, details, completionMode, paneContext: paneContext || null } });
    await get().load();
  },
  stop: async (id) => { await invoke("kanban_stop", { id }); await get().load(); },
  retry: async (id) => { await invoke("kanban_retry", { id }); await get().load(); },
  approve: async (id) => { await invoke("kanban_approve", { id }); await get().load(); },
  subscribe: async () => listen("kanban://task_activity", async (event: { payload: { taskId?: string } }) => {
    await get().load();
    if (event.payload.taskId && get().selected?.task.id === event.payload.taskId) await get().inspect(event.payload.taskId);
  }),
}));
