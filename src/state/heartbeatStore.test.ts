import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useHeartbeatStore } from './heartbeatStore';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

function resetStore() {
  useHeartbeatStore.setState({
    heartbeats: [],
    executions: {},
    suggestions: {},
    selectedExecution: null,
  });
}

describe('useHeartbeatStore', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  it('should initialize with empty state', () => {
    const state = useHeartbeatStore.getState();

    expect(state.heartbeats).toEqual([]);
    expect(state.executions).toEqual({});
    expect(state.suggestions).toEqual({});
    expect(state.selectedExecution).toBeNull();
  });

  it('should load heartbeats from Tauri', async () => {
    const mockHeartbeats = [
      {
        id: '1',
        name: 'Test Heartbeat',
        description: 'Test',
        intervalMinutes: 60,
        retentionDays: 30,
        enabled: true,
        nextRunAt: null,
        createdAt: 123456,
        updatedAt: 123456,
      },
    ];

    (invoke as any).mockResolvedValue(mockHeartbeats);

    await useHeartbeatStore.getState().loadHeartbeats();

    expect(useHeartbeatStore.getState().heartbeats).toEqual(mockHeartbeats);
    expect(invoke).toHaveBeenCalledWith('heartbeat_list');
  });

  it('should load executions for a heartbeat', async () => {
    const mockExecutions = [
      {
        id: 'exec-1',
        heartbeatId: 'hb-1',
        status: 'completed' as const,
        startedAt: 123456,
        completedAt: 123500,
        durationMs: 44,
        overallSeverity: 'ok' as const,
      },
    ];

    (invoke as any).mockResolvedValue(mockExecutions);

    await useHeartbeatStore.getState().loadExecutions('hb-1');

    expect(useHeartbeatStore.getState().executions['hb-1']).toEqual(mockExecutions);
    expect(invoke).toHaveBeenCalledWith('heartbeat_executions', { id: 'hb-1', limit: 50 });
  });

  it('should load suggestions for a heartbeat', async () => {
    const mockSuggestions = [
      {
        id: 'sugg-1',
        heartbeatId: 'hb-1',
        suggestion_type: 'add_checks' as const,
        description: 'Add memory checks',
        proposed_checks_json: '[]',
        createdAt: 123456,
      },
    ];

    (invoke as any).mockResolvedValue(mockSuggestions);

    await useHeartbeatStore.getState().loadSuggestions('hb-1');

    expect(useHeartbeatStore.getState().suggestions['hb-1']).toEqual(mockSuggestions);
    expect(invoke).toHaveBeenCalledWith('heartbeat_suggestions_get', { id: 'hb-1' });
  });

  it('should load execution detail', async () => {
    const mockDetail = {
      execution: {
        id: 'exec-1',
        heartbeatId: 'hb-1',
        status: 'completed' as const,
        startedAt: 123456,
        completedAt: 123500,
        durationMs: 44,
        overallSeverity: 'ok' as const,
      },
      checkGroups: [
        {
          id: 'cg-1',
          name: 'System Health',
          severity: 'ok',
          findings: [],
        },
      ],
    };

    (invoke as any).mockResolvedValue(mockDetail);

    await useHeartbeatStore.getState().loadExecutionDetail('exec-1');

    expect(useHeartbeatStore.getState().selectedExecution).toEqual(mockDetail);
    expect(invoke).toHaveBeenCalledWith('heartbeat_execution_detail', { executionId: 'exec-1' });
  });

  it('should clear execution detail', () => {
    useHeartbeatStore.setState({
      selectedExecution: {
        execution: {
          id: 'exec-1',
          heartbeatId: 'hb-1',
          status: 'completed',
          startedAt: 123456,
          completedAt: 123500,
          durationMs: 44,
          overallSeverity: 'ok',
        },
        checkGroups: [],
      },
    });

    useHeartbeatStore.getState().clearExecutionDetail();

    expect(useHeartbeatStore.getState().selectedExecution).toBeNull();
  });
});
