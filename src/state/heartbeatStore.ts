import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export type Heartbeat = {
  id: string;
  name: string;
  description: string;
  intervalMinutes: number;
  retentionDays: number;
  enabled: boolean;
  nextRunAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type Execution = {
  id: string;
  heartbeatId: string;
  status: 'running' | 'completed' | 'completed_with_errors' | 'failed';
  startedAt: number;
  completedAt: number | null;
  durationMs: number | null;
  overallSeverity: 'ok' | 'info' | 'warning' | 'critical' | 'error';
};

export type FindingDetail = {
  id: string;
  severity: string;
  title: string;
  message: string;
  metadata: Record<string, any> | null;
};

export type CheckGroup = {
  id: string;
  name: string;
  severity: string;
  findings: FindingDetail[];
};

export type ExecutionDetail = {
  execution: Execution;
  checkGroups: CheckGroup[];
};

export type Suggestion = {
  id: string;
  heartbeat_id: string;
  suggestion_type: 'add_checks' | 'remove_checks' | 'modify_checks';
  description: string;
  proposed_checks_json: string;
  created_at: number;
};

type Store = {
  heartbeats: Heartbeat[];
  executions: Record<string, Execution[]>;
  suggestions: Record<string, Suggestion[]>;
  selectedExecution: ExecutionDetail | null;

  loadHeartbeats: () => Promise<void>;
  loadExecutions: (heartbeatId: string) => Promise<void>;
  loadSuggestions: (heartbeatId: string) => Promise<void>;
  loadExecutionDetail: (executionId: string) => Promise<void>;
  clearExecutionDetail: () => void;
  subscribeToEvents: () => Promise<() => void>;
};

export const useHeartbeatStore = create<Store>((set) => ({
  heartbeats: [],
  executions: {},
  suggestions: {},
  selectedExecution: null,

  loadHeartbeats: async () => {
    const heartbeats = await invoke<Heartbeat[]>('heartbeat_list');
    set({ heartbeats });
  },

  loadExecutions: async (heartbeatId: string) => {
    const executions = await invoke<Execution[]>('heartbeat_executions', {
      id: heartbeatId,
      limit: 50,
    });
    set((state) => ({
      executions: { ...state.executions, [heartbeatId]: executions },
    }));
  },

  loadSuggestions: async (heartbeatId: string) => {
    const suggestions = await invoke<Suggestion[]>('heartbeat_suggestions_get', {
      id: heartbeatId,
    });
    set((state) => ({
      suggestions: { ...state.suggestions, [heartbeatId]: suggestions },
    }));
  },

  loadExecutionDetail: async (executionId: string) => {
    const detail = await invoke<ExecutionDetail>('heartbeat_execution_detail', {
      executionId,
    });
    set({ selectedExecution: detail });
  },

  clearExecutionDetail: () => {
    set({ selectedExecution: null });
  },

  subscribeToEvents: async () => {
    const unlistenCompletion = await listen('heartbeat://execution_completed', (event: any) => {
      const { heartbeatId } = event.payload;
      const store = useHeartbeatStore.getState();
      store.loadHeartbeats();
      // Always reload executions for this heartbeat — not just when already in
      // the store. The card's status badge is derived from the latest
      // execution, so if we skip this when the card isn't expanded, a finished
      // run keeps showing "running" until the user manually expands it.
      if (heartbeatId) {
        store.loadExecutions(heartbeatId);
      }
    });

    const unlistenNotification = await listen('heartbeat://critical_notification', (event: any) => {
      const { heartbeatId, executionId } = event.payload;
      const store = useHeartbeatStore.getState();
      // Emit browser notification
      const notification = new Notification(event.payload.title, {
        body: event.payload.body,
        icon: '/icon.png',
        tag: `heartbeat-${executionId}`,
      });

      // Handle click to load execution
      notification.onclick = async () => {
        try {
          await store.loadExecutionDetail(executionId);
          // Emit an event to switch to heartbeat tab
          window.dispatchEvent(new CustomEvent('show-heartbeat-tab', {
            detail: { executionId, heartbeatId }
          }));
          notification.close();
        } catch (error) {
          console.error('Failed to load execution detail:', error);
        }
      };
    });

    return () => {
      unlistenCompletion();
      unlistenNotification();
    };
  },
}));
