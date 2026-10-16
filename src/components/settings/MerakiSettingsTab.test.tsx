import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MerakiSettingsTab from './MerakiSettingsTab';
import * as tauri from '../../lib/tauri';

vi.mock('../../lib/tauri', () => ({
  merakiGetConfig: vi.fn(),
  merakiSaveConfig: vi.fn(),
  merakiTestConnection: vi.fn(),
}));

describe('MerakiSettingsTab', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(tauri.merakiGetConfig).mockResolvedValue(null);
    vi.mocked(tauri.merakiSaveConfig).mockResolvedValue(undefined);
  });

  it('explains that Meraki Dashboard and Cisco Workflows share one saved connection', () => {
    render(<MerakiSettingsTab />);

    expect(screen.getByText(/Meraki Dashboard and Cisco Workflows share the same saved API key/i)).toBeInTheDocument();
    expect(screen.getAllByLabelText('API Key')).toHaveLength(1);
  });

  it('requires an organization ID for Workflows without requiring it for Dashboard', async () => {
    render(<MerakiSettingsTab />);

    const org = screen.getByLabelText('Organization ID');
    expect(org).not.toBeRequired();
    expect(org).toHaveAccessibleDescription(/required.*Cisco Workflows/i);
    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(tauri.merakiSaveConfig).toHaveBeenCalledWith({ apiKey: 'synthetic-key', orgId: '' });
    });
  });

  it('keeps the configured organization ID instead of selecting one automatically', async () => {
    vi.mocked(tauri.merakiGetConfig).mockResolvedValue({ apiKey: 'synthetic-key', orgId: 'org-test-1' });
    render(<MerakiSettingsTab />);

    await waitFor(() => expect(screen.getByLabelText('Organization ID')).toHaveValue('org-test-1'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => {
      expect(tauri.merakiSaveConfig).toHaveBeenCalledWith({ apiKey: 'synthetic-key', orgId: 'org-test-1' });
    });
  });

  it('labels the existing connection check as Dashboard-only', async () => {
    vi.mocked(tauri.merakiTestConnection).mockResolvedValue({ ok: true, message: 'Dashboard accessible' });
    render(<MerakiSettingsTab />);

    fireEvent.change(screen.getByLabelText('API Key'), { target: { value: 'synthetic-key' } });
    fireEvent.click(screen.getByRole('button', { name: 'Test Dashboard Connection' }));

    await waitFor(() => {
      expect(tauri.merakiTestConnection).toHaveBeenCalledWith({ apiKey: 'synthetic-key', orgId: '' });
    });
  });
});
