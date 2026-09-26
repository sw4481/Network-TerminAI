import { create } from "zustand";
import type { DeviceKind } from "../lib/fanout";

export type DeviceStatus =
  | "pending"
  | "running"
  | "success"
  | "failed"
  | "timeout"
  | "cancelled";

export type RunStatus =
  | "running"
  | "success"
  | "partial"
  | "failed"
  | "cancelled";

export interface DeviceRunState {
  deviceId: string;
  deviceKind: DeviceKind;
  displayName: string;
  status: DeviceStatus;
  attempt: number;
  progressBytes: number;
  durationMs?: number;
  errorMessage?: string;
  blockId?: string;
  parsedOutputId?: string;
  failureKind?: string;
}

export interface ActiveRun {
  runId: string;
  command: string;
  groupId: string | null;
  startedAt: number;
  endedAt?: number;
  status: RunStatus;
  totalDevices: number;
  devices: Record<string, DeviceRunState>; // key = `${kind}:${id}`
}

interface State {
  activeRunsById: Record<string, ActiveRun>;
  selectedRunId: string | null;
  selectedTab: string; // "merged" | `${kind}:${id}`
  selectRun: (id: string | null) => void;
  selectTab: (tab: string) => void;
  applyEvent: (e: any) => void;
}

const key = (kind: string, id: string) => `${kind}:${id}`;

export const useFanoutRunsStore = create<State>((set) => ({
  activeRunsById: {},
  selectedRunId: null,
  selectedTab: "merged",

  selectRun: (id) => set({ selectedRunId: id, selectedTab: "merged" }),
  selectTab: (tab) => set({ selectedTab: tab }),

  applyEvent: (e: any) =>
    set((state) => {
      const next = { ...state.activeRunsById };
      switch (e.kind) {
        case "run_started": {
          next[e.run_id] = {
            runId: e.run_id,
            command: e.command,
            groupId: e.group_id ?? null,
            startedAt: Date.now(),
            status: "running",
            totalDevices: e.total,
            devices: {},
          };
          return {
            activeRunsById: next,
            selectedRunId: state.selectedRunId ?? e.run_id,
            selectedTab: "merged",
          };
        }
        case "device_queued": {
          const run = next[e.run_id];
          if (!run) return state;
          const k = key(e.device_kind, e.device_id);
          run.devices[k] = run.devices[k] ?? {
            deviceId: e.device_id,
            deviceKind: e.device_kind as DeviceKind,
            displayName: e.display_name,
            status: "pending",
            attempt: e.attempt ?? 1,
            progressBytes: 0,
          };
          run.devices[k] = {
            ...run.devices[k],
            displayName: e.display_name,
            status: "pending",
            attempt: e.attempt ?? run.devices[k].attempt,
          };
          next[e.run_id] = { ...run, devices: { ...run.devices } };
          return { activeRunsById: next };
        }
        case "device_started": {
          const run = next[e.run_id];
          if (!run) return state;
          const k = key(e.device_kind, e.device_id);
          const dev = run.devices[k];
          if (!dev) return state;
          run.devices[k] = { ...dev, status: "running", attempt: e.attempt };
          next[e.run_id] = { ...run, devices: { ...run.devices } };
          return { activeRunsById: next };
        }
        case "device_progress": {
          const run = next[e.run_id];
          if (!run) return state;
          const k = key(e.device_kind, e.device_id);
          const dev = run.devices[k];
          if (!dev) return state;
          run.devices[k] = { ...dev, progressBytes: e.bytes };
          next[e.run_id] = { ...run, devices: { ...run.devices } };
          return { activeRunsById: next };
        }
        case "device_succeeded": {
          const run = next[e.run_id];
          if (!run) return state;
          const k = key(e.device_kind, e.device_id);
          const dev = run.devices[k];
          if (!dev) return state;
          run.devices[k] = {
            ...dev,
            status: "success",
            attempt: e.attempt,
            durationMs: e.duration_ms,
            blockId: e.block_id,
            parsedOutputId: e.parsed_output_id ?? undefined,
          };
          next[e.run_id] = { ...run, devices: { ...run.devices } };
          return { activeRunsById: next };
        }
        case "device_failed": {
          const run = next[e.run_id];
          if (!run) return state;
          const k = key(e.device_kind, e.device_id);
          const dev = run.devices[k];
          if (!dev) return state;
          const isTimeout = e.failure_kind === "timeout";
          run.devices[k] = {
            ...dev,
            status: isTimeout ? "timeout" : "failed",
            attempt: e.attempt,
            durationMs: e.duration_ms,
            errorMessage: e.error,
            failureKind: e.failure_kind,
          };
          next[e.run_id] = { ...run, devices: { ...run.devices } };
          return { activeRunsById: next };
        }
        case "device_cancelled": {
          const run = next[e.run_id];
          if (!run) return state;
          const k = key(e.device_kind, e.device_id);
          const dev = run.devices[k];
          if (!dev) return state;
          run.devices[k] = { ...dev, status: "cancelled", attempt: e.attempt };
          next[e.run_id] = { ...run, devices: { ...run.devices } };
          return { activeRunsById: next };
        }
        case "run_completed": {
          const run = next[e.run_id];
          if (!run) return state;
          const total = e.succeeded + e.failed + e.cancelled;
          const status: RunStatus =
            total === 0
              ? "success"
              : e.succeeded === total
                ? "success"
                : e.failed === total
                  ? "failed"
                  : e.cancelled === total
                    ? "cancelled"
                    : "partial";
          next[e.run_id] = {
            ...run,
            status,
            endedAt: Date.now(),
          };
          return { activeRunsById: next };
        }
      }
      return state;
    }),
}));
