import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChangeWindowPanel } from './ChangeWindowPanel';
import { useChangeVerifyStore } from '../state/changeVerifyStore';
import type { CheckBundle, ChangeSnapshot, ReportSummary } from '../lib/changeVerify';

vi.mock('../state/changeVerifyStore');

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-fs', () => ({
  writeTextFile: vi.fn(),
}));

vi.mock('../lib/changeVerify', async () => {
  const actual = await vi.importActual<typeof import('../lib/changeVerify')>('../lib/changeVerify');
  return {
    ...actual,
    bundleGet: vi.fn(),
  };
});

describe('ChangeWindowPanel', () => {
  const mockBundle: CheckBundle = {
    id: 'bundle-1',
    name: 'Test Bundle',
    description: 'Test',
    vendor: 'cisco',
    platform: 'ios',
    commands: ['show version'],
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  const mockSnapshot: ChangeSnapshot = {
    id: 'snap-1',
    tab_id: 'tab-1',
    bundle_id: 'bundle-1',
    label: 'pre',
    captured_at: Date.now(),
    results: [{ command: 'show version', parsed_output_id: 1 }],
  };

  const mockReport: ReportSummary = {
    pre_snapshot_id: 'snap-1',
    post_snapshot_id: 'snap-2',
    bundle_id: 'bundle-1',
    counts: { red: 0, yellow: 0, green: 1 },
    deltas: [],
    matched_approved: [],
    notes: null,
  };

  const defaultMockStore = {
    selectedBundleId: null,
    selectBundle: vi.fn(),
    createBundle: vi.fn(),
    updateBundleCommands: vi.fn(),
    renameBundle: vi.fn(),
    deleteBundle: vi.fn(),
    runPreCheck: vi.fn(),
    runPostCheck: vi.fn(),
    preSnapshot: null,
    currentReport: null,
    clearSnapshots: vi.fn(),
    bundles: [mockBundle],
    loading: false,
    loadBundles: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue(defaultMockStore);
  });

  it('renders with close button', () => {
    const onClose = vi.fn();
    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={onClose}
      />
    );

    expect(screen.getByText('Change Verification')).toBeInTheDocument();
    const closeBtn = screen.getByLabelText(/close/i);
    expect(closeBtn).toBeInTheDocument();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={onClose}
      />
    );

    const closeBtn = screen.getByLabelText(/close/i);
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('starts in select stage', () => {
    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    // Should render BundlePicker which shows the create button
    expect(screen.getByText(/Create New Bundle/i)).toBeInTheDocument();
  });

  it('renders timeline', () => {
    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    expect(screen.getByText('Select Bundle')).toBeInTheDocument();
    expect(screen.getByText('Pre-Check')).toBeInTheDocument();
    expect(screen.getByText('Make Change')).toBeInTheDocument();
    expect(screen.getByText('Post-Check')).toBeInTheDocument();
    expect(screen.getByText('Review')).toBeInTheDocument();
  });

  it('shows run pre-check button when bundle selected', () => {
    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultMockStore,
      selectedBundleId: 'bundle-1',
    });

    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /Run Pre-Check/i })).toBeInTheDocument();
  });

  it('transitions to pre-running stage when run pre-check clicked', async () => {
    const mockRunPreCheck = vi.fn().mockResolvedValue(mockSnapshot);

    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultMockStore,
      selectedBundleId: 'bundle-1',
      runPreCheck: mockRunPreCheck,
    });

    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    const runBtn = screen.getByRole('button', { name: /Run Pre-Check/i });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(screen.getByText(/Running pre-check/i)).toBeInTheDocument();
    });
  });

  it('transitions to pre-done stage after successful pre-check', async () => {
    const mockRunPreCheck = vi.fn().mockResolvedValue(mockSnapshot);

    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultMockStore,
      selectedBundleId: 'bundle-1',
      runPreCheck: mockRunPreCheck,
      preSnapshot: null,
    });

    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    const runBtn = screen.getByRole('button', { name: /Run Pre-Check/i });
    fireEvent.click(runBtn);

    await waitFor(() => {
      expect(mockRunPreCheck).toHaveBeenCalledWith('tab-1', 'bundle-1', 'cisco', 'ios');
    });
  });

  it('transitions to change-open stage when start change clicked', async () => {
    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultMockStore,
      selectedBundleId: 'bundle-1',
      preSnapshot: mockSnapshot,
    });

    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    // Wait for component to render with snapshot
    await waitFor(() => {
      expect(screen.getByText(/Start Change/i)).toBeInTheDocument();
    });

    const startBtn = screen.getByRole('button', { name: /Start Change/i });
    fireEvent.click(startBtn);

    await waitFor(() => {
      expect(screen.getByText(/I have made the change/i)).toBeInTheDocument();
    });
  });

  it('transitions to post-running stage when run post-check clicked', async () => {
    const mockRunPostCheck = vi.fn().mockResolvedValue({
      id: 'report-1',
      summary: mockReport,
    });

    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultMockStore,
      selectedBundleId: 'bundle-1',
      preSnapshot: mockSnapshot,
      runPostCheck: mockRunPostCheck,
    });

    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    // Navigate to change-open stage first
    await waitFor(() => {
      const startBtn = screen.getByRole('button', { name: /Start Change/i });
      fireEvent.click(startBtn);
    });

    await waitFor(() => {
      const checkbox = screen.getByRole('checkbox');
      fireEvent.click(checkbox);
    });

    const runPostBtn = screen.getByRole('button', { name: /Run Post-Check/i });
    fireEvent.click(runPostBtn);

    await waitFor(() => {
      expect(screen.getByText(/Running post-check/i)).toBeInTheDocument();
    });
  });

  it('shows report stage after successful post-check', async () => {
    const mockRunPostCheck = vi.fn().mockResolvedValue({
      id: 'report-1',
      summary: mockReport,
    });

    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultMockStore,
      selectedBundleId: 'bundle-1',
      preSnapshot: mockSnapshot,
      runPostCheck: mockRunPostCheck,
      currentReport: { id: 'report-1', summary: mockReport, approved: [] },
    });

    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    // Should show done button in report stage
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Done/i })).toBeInTheDocument();
    });
  });

  it('returns to select stage when done clicked', async () => {
    const mockClearSnapshots = vi.fn();
    const mockSelectBundle = vi.fn();

    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultMockStore,
      selectedBundleId: 'bundle-1',
      currentReport: { id: 'report-1', summary: mockReport, approved: [] },
      clearSnapshots: mockClearSnapshots,
      selectBundle: mockSelectBundle,
    });

    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    const doneBtn = screen.getByRole('button', { name: /Done/i });
    fireEvent.click(doneBtn);

    expect(mockClearSnapshots).toHaveBeenCalledOnce();
    expect(mockSelectBundle).toHaveBeenCalledWith(null);

    await waitFor(() => {
      expect(screen.getByText(/Create New Bundle/i)).toBeInTheDocument();
    });
  });

  it('opens bundle editor when create new clicked', async () => {
    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    const createBtn = screen.getByText(/Create New Bundle/i);
    fireEvent.click(createBtn);

    await waitFor(() => {
      expect(screen.getByText('Create Bundle')).toBeInTheDocument();
    });
  });

  it('shows export markdown button in report stage', async () => {
    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultMockStore,
      selectedBundleId: 'bundle-1',
      currentReport: { id: 'report-1', summary: mockReport, approved: [], createdAt: 1715000000 },
    });

    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Export Markdown/i })).toBeInTheDocument();
    });
  });

  it('exports markdown when export button clicked', async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const { bundleGet } = await import('../lib/changeVerify');

    vi.mocked(save).mockResolvedValue('/tmp/report.md');
    vi.mocked(writeTextFile).mockResolvedValue();
    vi.mocked(bundleGet).mockResolvedValue(mockBundle);

    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultMockStore,
      selectedBundleId: 'bundle-1',
      currentReport: { id: 'report-1', summary: mockReport, approved: [], createdAt: 1715000000 },
    });

    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    const exportBtn = screen.getByRole('button', { name: /Export Markdown/i });
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(save).toHaveBeenCalledWith({
        defaultPath: 'change-report-Test_Bundle-1715000000.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      expect(writeTextFile).toHaveBeenCalledWith('/tmp/report.md', expect.stringContaining('# Change Verification Report'));
    });
  });

  it('does not export if save dialog cancelled', async () => {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { writeTextFile } = await import('@tauri-apps/plugin-fs');
    const { bundleGet } = await import('../lib/changeVerify');

    vi.mocked(save).mockResolvedValue(null);
    vi.mocked(bundleGet).mockResolvedValue(mockBundle);

    (useChangeVerifyStore as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      ...defaultMockStore,
      selectedBundleId: 'bundle-1',
      currentReport: { id: 'report-1', summary: mockReport, approved: [], createdAt: 1715000000 },
    });

    render(
      <ChangeWindowPanel
        tabId="tab-1"
        vendor="cisco"
        platform="ios"
        onClose={vi.fn()}
      />
    );

    const exportBtn = screen.getByRole('button', { name: /Export Markdown/i });
    fireEvent.click(exportBtn);

    await waitFor(() => {
      expect(save).toHaveBeenCalled();
    });

    expect(writeTextFile).not.toHaveBeenCalled();
  });
});
