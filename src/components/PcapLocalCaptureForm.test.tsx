import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PcapLocalCaptureForm } from './PcapLocalCaptureForm';

const invokeMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

describe('PcapLocalCaptureForm', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'pcap_list_local_interfaces') {
        return Promise.resolve([{ selector: '2', label: 'en0 (Wi-Fi)' }]);
      }
      if (command === 'pcap_start_local_capture') {
        return Promise.resolve({ capture_id: 'local-capture-id' });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    });
  });

  it('uses bounded defaults and passes the selected label with the selector', async () => {
    const onStarted = vi.fn();
    render(<PcapLocalCaptureForm onStarted={onStarted} />);
    await screen.findByText('2. en0 (Wi-Fi)');

    fireEvent.change(screen.getByTestId('pcap-local-filter'), {
      target: { value: 'udp port 53' },
    });
    fireEvent.click(screen.getByTestId('pcap-local-run'));

    await waitFor(() => expect(onStarted).toHaveBeenCalledWith('local-capture-id'));
    expect(invokeMock).toHaveBeenCalledWith('pcap_start_local_capture', {
      args: {
        interfaceSelector: '2',
        interfaceLabel: 'en0 (Wi-Fi)',
        captureFilter: 'udp port 53',
        durationSeconds: 30,
        maxSizeMiB: 100,
      },
    });
  });

  it('surfaces dumpcap preflight errors', async () => {
    invokeMock.mockRejectedValueOnce(new Error('dumpcap was not found'));
    render(<PcapLocalCaptureForm />);
    expect(await screen.findByText(/dumpcap was not found/)).toBeInTheDocument();
    expect(screen.getByTestId('pcap-local-run')).toBeDisabled();
  });
});
