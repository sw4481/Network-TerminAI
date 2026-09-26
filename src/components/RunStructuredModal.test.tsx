import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

const runAndParseOverSshMock = vi.fn();
vi.mock('../lib/structured', () => ({
  runAndParseOverSsh: (...args: unknown[]) => runAndParseOverSshMock(...args),
}));

const listSshConnectionsMock = vi.fn();
vi.mock('../lib/resolveTabConnection', () => ({
  listSshConnections: () => listSshConnectionsMock(),
  matchConnectionForTab: (
    conns: Array<{ id: string; host: string; user: string | null }>,
    ctx: { host: string; user: string | null } | null,
  ) => {
    if (!ctx) return null;
    return conns.find((c) => c.host === ctx.host) ?? null;
  },
  resolveSshPassword: vi.fn(async () => 'resolved-password'),
}));

const getPasswordContextMock = vi.fn();
vi.mock('../state/sshPasswordStore', () => ({
  useSshPasswordStore: (selector: (s: unknown) => unknown) =>
    selector({ getPasswordContext: getPasswordContextMock }),
}));

const setTabVendorMock = vi.fn();
vi.mock('../state/tabsStore', () => ({
  useTabs: (selector: (s: unknown) => unknown) =>
    selector({
      tabs: [{ id: 'tab-1', vendor: 'cisco', platform: 'iosxe' }],
      setTabVendor: setTabVendorMock,
    }),
}));

vi.mock('./StructuredTab', () => ({
  StructuredTab: ({
    blockId,
    onExportCsv,
    onExportJson,
    onCopyMarkdown,
    onPinSnapshot,
  }: {
    blockId: string;
    onExportCsv?: (rows: Record<string, unknown>[], columns: string[]) => void;
    onExportJson?: (rows: Record<string, unknown>[]) => void;
    onCopyMarkdown?: (rows: Record<string, unknown>[], columns: string[]) => void;
    onPinSnapshot?: () => void;
  }) => (
    <div data-testid="structured-tab">
      {blockId}
      <button data-testid="tab-export-csv" onClick={() => onExportCsv?.([{ a: 1 }], ['a'])}>csv</button>
      <button data-testid="tab-export-json" onClick={() => onExportJson?.([{ a: 1 }])}>json</button>
      <button data-testid="tab-copy-md" onClick={() => onCopyMarkdown?.([{ a: 1 }], ['a'])}>md</button>
      <button data-testid="tab-pin" onClick={() => onPinSnapshot?.()}>pin</button>
    </div>
  ),
}));

const downloadFileMock = vi.fn();
const copyToClipboardMock = vi.fn((_text?: string) => Promise.resolve());
vi.mock('../lib/export', () => ({
  toCsv: () => 'csv-content',
  toJson: () => 'json-content',
  toMarkdownTable: () => 'md-content',
  downloadFile: (name: string, content: string, mime: string) => downloadFileMock(name, content, mime),
  copyToClipboard: (text: string) => copyToClipboardMock(text),
}));

vi.mock('./SnapshotPinDialog', () => ({
  SnapshotPinDialog: ({ blockId }: { blockId: string }) => (
    <div data-testid="pin-dialog">{blockId}</div>
  ),
}));
vi.mock('./StructuredDiff', () => ({
  StructuredDiff: ({ blockId }: { blockId: string }) => <div data-testid="structured-diff">{blockId}</div>,
}));
vi.mock('./PasswordPromptModal', () => ({
  PasswordPromptModal: ({ isOpen }: { isOpen: boolean }) => (isOpen ? <div data-testid="password-modal" /> : null),
}));

import { RunStructuredModal } from './RunStructuredModal';

beforeEach(() => {
  runAndParseOverSshMock.mockReset();
  listSshConnectionsMock.mockReset();
  getPasswordContextMock.mockReset();
  setTabVendorMock.mockReset();
  downloadFileMock.mockReset();
  copyToClipboardMock.mockClear();
});

async function renderToResult() {
  listSshConnectionsMock.mockResolvedValue([
    { id: 'conn-1', name: 'Switch 1', host: '10.0.0.1', user: 'admin', port: 22, identity_file: null, password_encrypted: null, created_at: 0, last_used_at: null },
  ]);
  getPasswordContextMock.mockReturnValue({ host: '10.0.0.1', user: 'admin', password: 'ctx-pw' });
  runAndParseOverSshMock.mockResolvedValue('ssh-adhoc-block-1');
  const utils = render(
    <RunStructuredModal tabId="tab-1" initialCommand="show ip interface brief" onClose={vi.fn()} />,
  );
  await waitFor(() => expect(listSshConnectionsMock).toHaveBeenCalled());
  fireEvent.click(utils.getByText(/^Run$/));
  await waitFor(() => expect(utils.getByTestId('structured-tab')).toBeTruthy());
  return utils;
}

describe('RunStructuredModal', () => {
  it('auto-resolves connection + device type, runs the command, and shows the result tabs', async () => {
    listSshConnectionsMock.mockResolvedValue([
      { id: 'conn-1', name: 'Switch 1', host: '10.0.0.1', user: 'admin', port: 22, identity_file: null, password_encrypted: null, created_at: 0, last_used_at: null },
    ]);
    getPasswordContextMock.mockReturnValue({ host: '10.0.0.1', user: 'admin', password: 'ctx-pw' });
    runAndParseOverSshMock.mockResolvedValue('ssh-adhoc-block-1');

    const onClose = vi.fn();
    const { getByText } = render(
      <RunStructuredModal tabId="tab-1" initialCommand="show ip interface brief" onClose={onClose} />,
    );

    await waitFor(() => expect(listSshConnectionsMock).toHaveBeenCalled());

    fireEvent.click(getByText(/^Run$/));

    await waitFor(() =>
      expect(runAndParseOverSshMock).toHaveBeenCalledWith(
        'tab-1',
        'conn-1',
        'show ip interface brief',
        'cisco',
        'iosxe',
        'resolved-password',
      ),
    );

    await waitFor(() => expect(getByText(/ssh-adhoc-block-1/)).toBeTruthy());
  });

  it('surfaces an SSH exec error inline instead of throwing', async () => {
    listSshConnectionsMock.mockResolvedValue([
      { id: 'conn-1', name: 'Switch 1', host: '10.0.0.1', user: 'admin', port: 22, identity_file: null, password_encrypted: null, created_at: 0, last_used_at: null },
    ]);
    getPasswordContextMock.mockReturnValue({ host: '10.0.0.1', user: 'admin', password: 'ctx-pw' });
    runAndParseOverSshMock.mockRejectedValue(new Error('ssh: connection timed out'));

    const { getByText } = render(
      <RunStructuredModal tabId="tab-1" initialCommand="show version" onClose={vi.fn()} />,
    );

    await waitFor(() => expect(listSshConnectionsMock).toHaveBeenCalled());
    fireEvent.click(getByText(/^Run$/));

    await waitFor(() => expect(getByText(/connection timed out/)).toBeTruthy());
    expect(getByText(/Retry/)).toBeTruthy();
  });

  it('switches from the Table view to the Diff view when the Diff toggle is clicked', async () => {
    listSshConnectionsMock.mockResolvedValue([
      { id: 'conn-1', name: 'Switch 1', host: '10.0.0.1', user: 'admin', port: 22, identity_file: null, password_encrypted: null, created_at: 0, last_used_at: null },
    ]);
    getPasswordContextMock.mockReturnValue({ host: '10.0.0.1', user: 'admin', password: 'ctx-pw' });
    runAndParseOverSshMock.mockResolvedValue('ssh-adhoc-block-1');

    const { getByText, getByTestId, queryByTestId } = render(
      <RunStructuredModal tabId="tab-1" initialCommand="show ip interface brief" onClose={vi.fn()} />,
    );

    await waitFor(() => expect(listSshConnectionsMock).toHaveBeenCalled());
    fireEvent.click(getByText(/^Run$/));

    await waitFor(() => expect(getByTestId('structured-tab')).toBeTruthy());
    expect(queryByTestId('structured-diff')).toBeNull();

    fireEvent.click(getByText(/^Diff$/));

    expect(queryByTestId('structured-tab')).toBeNull();
    expect(getByTestId('structured-diff')).toBeTruthy();
  });

  it('wires Export CSV / JSON to a file download in the result view', async () => {
    const { getByTestId } = await renderToResult();

    fireEvent.click(getByTestId('tab-export-csv'));
    await waitFor(() => expect(downloadFileMock).toHaveBeenCalledTimes(1));
    expect(downloadFileMock.mock.calls[0][0]).toMatch(/\.csv$/);

    fireEvent.click(getByTestId('tab-export-json'));
    await waitFor(() => expect(downloadFileMock).toHaveBeenCalledTimes(2));
    expect(downloadFileMock.mock.calls[1][0]).toMatch(/\.json$/);
  });

  it('wires Copy as Markdown to the clipboard in the result view', async () => {
    const { getByTestId } = await renderToResult();

    fireEvent.click(getByTestId('tab-copy-md'));
    await waitFor(() => expect(copyToClipboardMock).toHaveBeenCalledWith('md-content'));
  });

  it('opens the Pin Snapshot dialog from the result view', async () => {
    const { getByTestId, queryByTestId } = await renderToResult();

    expect(queryByTestId('pin-dialog')).toBeNull();
    fireEvent.click(getByTestId('tab-pin'));
    await waitFor(() => expect(getByTestId('pin-dialog')).toBeTruthy());
  });
});
