/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { HeartbeatTab } from './HeartbeatTab';
import { useHeartbeatStore } from '../state/heartbeatStore';
import type { Heartbeat } from '../state/heartbeatStore';

// Mock the Tauri APIs
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}));

vi.mock('../lib/tauri', () => ({
  pauseHeartbeat: vi.fn(),
  resumeHeartbeat: vi.fn(),
  deleteHeartbeat: vi.fn(),
  triggerHeartbeatNow: vi.fn(),
}));

function resetStore() {
  useHeartbeatStore.setState({
    heartbeats: [],
    executions: {},
    suggestions: {},
    selectedExecution: null,
  });
}

describe('HeartbeatTab', () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  afterEach(() => {
    resetStore();
  });

  it('renders empty state when no heartbeats', async () => {
    render(<HeartbeatTab />);

    await waitFor(() => {
      expect(screen.getByText('No heartbeats configured')).toBeInTheDocument();
    });
  });

  it('displays heartbeat count when data present', async () => {
    const mockHeartbeat: Heartbeat = {
      id: 'hb-1',
      name: 'Test Heartbeat',
      description: 'Test description',
      intervalMinutes: 30,
      retentionDays: 7,
      enabled: true,
      nextRunAt: Math.floor(Date.now() / 1000) + 1800,
      createdAt: 1234567890,
      updatedAt: 1234567890,
    };

    useHeartbeatStore.setState({
      heartbeats: [mockHeartbeat],
      executions: {},
      suggestions: {},
      selectedExecution: null,
    });

    render(<HeartbeatTab />);

    await waitFor(() => {
      expect(screen.getByText('Test Heartbeat')).toBeInTheDocument();
      expect(screen.getByText('Test description')).toBeInTheDocument();
      expect(screen.getByText('1 configured')).toBeInTheDocument();
    });
  });

  it('shows paused badge for disabled heartbeats', async () => {
    const mockHeartbeat: Heartbeat = {
      id: 'hb-1',
      name: 'Paused HB',
      description: '',
      intervalMinutes: 15,
      retentionDays: 7,
      enabled: false,
      nextRunAt: null,
      createdAt: 1234567890,
      updatedAt: 1234567890,
    };

    useHeartbeatStore.setState({
      heartbeats: [mockHeartbeat],
      executions: {},
      suggestions: {},
      selectedExecution: null,
    });

    render(<HeartbeatTab />);

    await waitFor(() => {
      expect(screen.getByText('Paused HB')).toBeInTheDocument();
      expect(screen.getByText('Paused')).toBeInTheDocument();
    });
  });

  it('displays multiple heartbeats', async () => {
    const hb1: Heartbeat = {
      id: 'hb-1',
      name: 'HB 1',
      description: '',
      intervalMinutes: 15,
      retentionDays: 7,
      enabled: true,
      nextRunAt: null,
      createdAt: 1234567890,
      updatedAt: 1234567890,
    };

    const hb2: Heartbeat = {
      id: 'hb-2',
      name: 'HB 2',
      description: '',
      intervalMinutes: 30,
      retentionDays: 7,
      enabled: false,
      nextRunAt: null,
      createdAt: 1234567890,
      updatedAt: 1234567890,
    };

    useHeartbeatStore.setState({
      heartbeats: [hb1, hb2],
      executions: {},
      suggestions: {},
      selectedExecution: null,
    });

    render(<HeartbeatTab />);

    await waitFor(() => {
      expect(screen.getByText('HB 1')).toBeInTheDocument();
      expect(screen.getByText('HB 2')).toBeInTheDocument();
      expect(screen.getByText('2 configured')).toBeInTheDocument();
    });
  });
});
