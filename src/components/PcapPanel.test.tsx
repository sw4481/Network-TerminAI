import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PcapPanel } from './PcapPanel';

const mocks = vi.hoisted(() => ({
  captureList: vi.fn(),
  sshListConnections: vi.fn(),
}));

vi.mock('../lib/pcap', () => ({
  captureList: mocks.captureList,
}));

vi.mock('../lib/sshConnections', () => ({
  sshDecryptPassword: vi.fn(),
  sshListConnections: mocks.sshListConnections,
}));

vi.mock('./PcapTemplateLibrary', () => ({
  PcapTemplateLibrary: () => <div>Template library</div>,
}));

vi.mock('./PcapQuickCaptureWizard', () => ({
  PcapQuickCaptureWizard: () => <div>Quick capture wizard</div>,
}));

vi.mock('./PcapLocalCaptureForm', () => ({
  PcapLocalCaptureForm: () => <div>Local capture form</div>,
}));

vi.mock('./PcapBlock', () => ({
  PcapBlock: ({ captureId }: { captureId: string }) => <div>Capture {captureId}</div>,
}));

describe('PcapPanel viewer sizing', () => {
  beforeEach(() => {
    mocks.captureList.mockReset().mockResolvedValue([{
      id: 'capture-12345678',
      status: 'ready',
      device_ref: 'This Computer',
      interface: 'en0 (Wi-Fi)',
      size_bytes: 1024,
    }]);
    mocks.sshListConnections.mockReset().mockResolvedValue([]);
  });

  it('lets the active capture take the full panel width and restores setup columns', async () => {
    render(<PcapPanel />);

    const panel = screen.getByTestId('pcap-panel');
    const expand = screen.getByRole('button', { name: 'Expand viewer' });
    expect(expand).toBeDisabled();

    fireEvent.click(await screen.findByTestId('pcap-panel-recent-capture-12345678'));
    expect(expand).toBeEnabled();
    fireEvent.click(expand);

    expect(panel).toHaveClass('pcap-panel-viewer-expanded');
    expect(screen.getByRole('button', { name: 'Show setup' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Show setup' }));
    expect(panel).not.toHaveClass('pcap-panel-viewer-expanded');
  });
});
