import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChangeReportView } from './ChangeReportView';
import type { ReportSummary } from '../lib/changeVerify';
import { useChangeVerifyStore } from '../state/changeVerifyStore';

vi.mock('../state/changeVerifyStore');

describe('ChangeReportView', () => {
  const mockAppendApproval = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useChangeVerifyStore).mockImplementation((selector?: any) => {
      const state = { appendApproval: mockAppendApproval };
      return selector ? selector(state) : state;
    });
  });

  const mockReport: ReportSummary = {
    pre_snapshot_id: 'pre-1',
    post_snapshot_id: 'post-1',
    bundle_id: 'bundle-1',
    counts: { red: 2, yellow: 1, green: 1 },
    deltas: [
      {
        command: 'show ip interface brief',
        family: 'ios',
        severity: 'red',
        path: '/interfaces/GigabitEthernet0/0/status',
        before: 'up',
        after: 'down',
        message: 'Interface went down',
      },
      {
        command: 'show ip interface brief',
        family: 'ios',
        severity: 'red',
        path: '/interfaces/GigabitEthernet0/1/ip',
        before: '10.0.0.1',
        after: '10.0.0.2',
        message: 'IP address changed',
      },
      {
        command: 'show version',
        family: 'ios',
        severity: 'yellow',
        path: '/uptime',
        before: '1 day',
        after: '0 hours',
        message: 'Device rebooted',
      },
      {
        command: 'show running-config',
        family: 'ios',
        severity: 'green',
        path: '/config/hostname',
        before: 'oldhost',
        after: 'newhost',
        message: 'Expected hostname change',
      },
    ],
    matched_approved: [],
    notes: 'Test change notes',
  };

  it('renders severity count chips', () => {
    const { container } = render(<ChangeReportView report={mockReport} reportId="report-1" />);

    const summary = container.querySelector('.report-summary');
    expect(summary).toBeInTheDocument();

    const redChip = summary?.querySelector('[data-testid="severity-chip-red"]');
    const yellowChip = summary?.querySelector('[data-testid="severity-chip-yellow"]');
    const greenChip = summary?.querySelector('[data-testid="severity-chip-green"]');

    expect(redChip).toHaveTextContent('2');
    expect(yellowChip).toHaveTextContent('1');
    expect(greenChip).toHaveTextContent('1');
  });

  it('renders change notes when present', () => {
    render(<ChangeReportView report={mockReport} reportId="report-1" />);

    expect(screen.getByText('Change Notes:')).toBeInTheDocument();
    expect(screen.getByText('Test change notes')).toBeInTheDocument();
  });

  it('does not render notes section when notes is null', () => {
    const reportWithoutNotes = { ...mockReport, notes: null };
    render(<ChangeReportView report={reportWithoutNotes} reportId="report-1" />);

    expect(screen.queryByText('Change Notes:')).not.toBeInTheDocument();
  });

  it('groups deltas by command', () => {
    render(<ChangeReportView report={mockReport} reportId="report-1" />);

    expect(screen.getByText('show ip interface brief')).toBeInTheDocument();
    expect(screen.getByText('show version')).toBeInTheDocument();
    expect(screen.getByText('show running-config')).toBeInTheDocument();
  });

  it('shows command count in group header', () => {
    render(<ChangeReportView report={mockReport} reportId="report-1" />);

    expect(screen.getByText('2 changes')).toBeInTheDocument();
    expect(screen.getAllByText('1 changes')).toHaveLength(2);
  });

  it('renders all delta rows', () => {
    render(<ChangeReportView report={mockReport} reportId="report-1" />);

    expect(screen.getByText('/interfaces/GigabitEthernet0/0/status')).toBeInTheDocument();
    expect(screen.getByText('/interfaces/GigabitEthernet0/1/ip')).toBeInTheDocument();
    expect(screen.getByText('/uptime')).toBeInTheDocument();
    expect(screen.getByText('/config/hostname')).toBeInTheDocument();
  });

  it('calls appendApproval when approve button clicked', async () => {
    render(<ChangeReportView report={mockReport} reportId="report-1" />);

    // Find and click approve on first red delta
    const approveButtons = screen.getAllByRole('button', { name: /approve/i });
    fireEvent.click(approveButtons[0]);

    await waitFor(() => {
      expect(mockAppendApproval).toHaveBeenCalledWith(
        'report-1',
        expect.objectContaining({
          note: 'approved by user',
        }),
      );
    });
  });

  it('does not show approve button for green deltas', () => {
    const greenOnlyReport: ReportSummary = {
      ...mockReport,
      counts: { red: 0, yellow: 0, green: 1 },
      deltas: [mockReport.deltas[3]], // Just the green delta
    };

    render(<ChangeReportView report={greenOnlyReport} reportId="report-1" />);

    const approveButtons = screen.queryAllByRole('button', { name: /approve/i });
    expect(approveButtons).toHaveLength(0);
  });

  it('displays counts from report summary', () => {
    render(<ChangeReportView report={mockReport} reportId="report-1" />);

    // Should display the counts from the report
    const initialCounts = screen.getAllByText(/^\d+$/);
    expect(initialCounts[0]).toHaveTextContent('2'); // red
    expect(initialCounts[1]).toHaveTextContent('1'); // yellow
    expect(initialCounts[2]).toHaveTextContent('1'); // green
  });
});
