import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ExecutionDetailDrawer } from './ExecutionDetailDrawer';
import { useHeartbeatStore } from '../state/heartbeatStore';

vi.mock('../state/heartbeatStore');

describe('ExecutionDetailDrawer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useHeartbeatStore).mockReturnValue({
      selectedExecution: null,
      clearExecutionDetail: vi.fn(),
    } as any);
  });

  it('renders nothing when selectedExecution is null', () => {
    const { container } = render(<ExecutionDetailDrawer />);
    expect(container.querySelector('.execution-detail-drawer')).toBeNull();
  });

  it('renders drawer with execution details', () => {
    vi.mocked(useHeartbeatStore).mockReturnValue({
      selectedExecution: {
        execution: {
          id: 'exec-1',
          heartbeatId: 'hb-1',
          status: 'completed',
          startedAt: 1719360000,
          completedAt: 1719360060,
          durationMs: 60000,
          overallSeverity: 'info',
        },
        checkGroups: [
          {
            id: 'check-1',
            name: 'Connectivity Checks',
            severity: 'ok',
            findings: [
              {
                id: 'finding-1',
                severity: 'ok',
                title: 'All devices reachable',
                message: 'Ping successful to all 10 devices',
                metadata: null,
              },
            ],
          },
        ],
      },
      clearExecutionDetail: vi.fn(),
    } as any);

    render(<ExecutionDetailDrawer />);

    expect(screen.getByText('Execution Details')).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
    expect(screen.getByText('Connectivity Checks')).toBeInTheDocument();

    // Expand the check group to see findings
    const checkGroup = screen.getByText('Connectivity Checks');
    fireEvent.click(checkGroup);

    expect(screen.getByText('All devices reachable')).toBeInTheDocument();
  });

  it('closes drawer when close button clicked', () => {
    const clearExecutionDetail = vi.fn();
    vi.mocked(useHeartbeatStore).mockReturnValue({
      selectedExecution: {
        execution: {
          id: 'exec-1',
          heartbeatId: 'hb-1',
          status: 'completed',
          startedAt: 1719360000,
          completedAt: 1719360060,
          durationMs: 60000,
          overallSeverity: 'info',
        },
        checkGroups: [],
      },
      clearExecutionDetail,
    } as any);

    render(<ExecutionDetailDrawer />);

    const closeButton = screen.getByTitle('Close');
    fireEvent.click(closeButton);

    expect(clearExecutionDetail).toHaveBeenCalled();
  });

  it('closes drawer when overlay clicked', () => {
    const clearExecutionDetail = vi.fn();
    vi.mocked(useHeartbeatStore).mockReturnValue({
      selectedExecution: {
        execution: {
          id: 'exec-1',
          heartbeatId: 'hb-1',
          status: 'completed',
          startedAt: 1719360000,
          completedAt: 1719360060,
          durationMs: 60000,
          overallSeverity: 'info',
        },
        checkGroups: [],
      },
      clearExecutionDetail,
    } as any);

    const { container } = render(<ExecutionDetailDrawer />);

    const overlay = container.querySelector('.execution-detail-overlay');
    expect(overlay).toBeTruthy();
    fireEvent.click(overlay!);

    expect(clearExecutionDetail).toHaveBeenCalled();
  });

  it('exports JSON when export button clicked', async () => {
    const mockExecution = {
      execution: {
        id: 'exec-1',
        heartbeatId: 'hb-1',
        status: 'completed' as const,
        startedAt: 1719360000,
        completedAt: 1719360060,
        durationMs: 60000,
        overallSeverity: 'info' as const,
      },
      checkGroups: [
        {
          id: 'check-1',
          name: 'Test Check',
          severity: 'ok',
          findings: [],
        },
      ],
    };

    vi.mocked(useHeartbeatStore).mockReturnValue({
      selectedExecution: mockExecution,
      clearExecutionDetail: vi.fn(),
    } as any);

    // Mock clipboard API
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, {
      clipboard: { writeText },
    });

    render(<ExecutionDetailDrawer />);

    const exportButton = screen.getByTitle('Export JSON');
    fireEvent.click(exportButton);

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('"id": "exec-1"')
    );
  });

  it('displays collapsible check groups', () => {
    vi.mocked(useHeartbeatStore).mockReturnValue({
      selectedExecution: {
        execution: {
          id: 'exec-1',
          heartbeatId: 'hb-1',
          status: 'completed',
          startedAt: 1719360000,
          completedAt: 1719360060,
          durationMs: 60000,
          overallSeverity: 'warning',
        },
        checkGroups: [
          {
            id: 'check-1',
            name: 'Group 1',
            severity: 'warning',
            findings: [
              {
                id: 'finding-1',
                severity: 'warning',
                title: 'Finding 1',
                message: 'Test message',
                metadata: null,
              },
            ],
          },
          {
            id: 'check-2',
            name: 'Group 2',
            severity: 'ok',
            findings: [],
          },
        ],
      },
      clearExecutionDetail: vi.fn(),
    } as any);

    render(<ExecutionDetailDrawer />);

    expect(screen.getByText('Group 1')).toBeInTheDocument();
    expect(screen.getByText('Group 2')).toBeInTheDocument();
  });
});
