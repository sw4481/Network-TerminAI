import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import StealthwatchSettingsTab from './StealthwatchSettingsTab';
import * as tauri from '../../lib/tauri';

vi.mock('../../lib/tauri', () => ({
  stealthwatchGetConfig: vi.fn(),
  stealthwatchSaveConfig: vi.fn(),
  stealthwatchTestConnection: vi.fn(),
}));

describe('StealthwatchSettingsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders form fields and buttons', () => {
    vi.mocked(tauri.stealthwatchGetConfig).mockResolvedValue(null);

    render(<StealthwatchSettingsTab />);

    expect(screen.getByLabelText(/host/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/verify ssl/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument();
  });

  it('loads config from database on mount', async () => {
    const mockConfig = {
      host: 'smc.example.com',
      username: 'admin',
      password: 'secret',
      verifySsl: true,
    };
    vi.mocked(tauri.stealthwatchGetConfig).mockResolvedValue(mockConfig);

    render(<StealthwatchSettingsTab />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('smc.example.com')).toBeInTheDocument();
      expect(screen.getByDisplayValue('admin')).toBeInTheDocument();
    });
  });

  it('validates empty host before testing', async () => {
    vi.mocked(tauri.stealthwatchGetConfig).mockResolvedValue(null);

    render(<StealthwatchSettingsTab />);

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/enter a host before testing/i)).toBeInTheDocument();
    });

    expect(tauri.stealthwatchTestConnection).not.toHaveBeenCalled();
  });

  it('calls stealthwatchTestConnection and displays success', async () => {
    vi.mocked(tauri.stealthwatchGetConfig).mockResolvedValue(null);
    vi.mocked(tauri.stealthwatchTestConnection).mockResolvedValue({
      ok: true,
      message: 'Connected. Tenant ID: 123',
    });

    render(<StealthwatchSettingsTab />);

    fireEvent.change(screen.getByLabelText(/host/i), {
      target: { value: 'smc.test.local' },
    });

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/Connected\. Tenant ID: 123/)).toBeInTheDocument();
    });
  });

  it('displays error message on test failure', async () => {
    vi.mocked(tauri.stealthwatchGetConfig).mockResolvedValue(null);
    vi.mocked(tauri.stealthwatchTestConnection).mockResolvedValue({
      ok: false,
      message: 'Authentication failed',
    });

    render(<StealthwatchSettingsTab />);

    fireEvent.change(screen.getByLabelText(/host/i), {
      target: { value: 'smc.test.local' },
    });

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/Authentication failed/)).toBeInTheDocument();
    });
  });

  it('saves config to database and shows success', async () => {
    vi.mocked(tauri.stealthwatchGetConfig).mockResolvedValue(null);
    vi.mocked(tauri.stealthwatchSaveConfig).mockResolvedValue(undefined);

    render(<StealthwatchSettingsTab />);

    fireEvent.change(screen.getByLabelText(/host/i), {
      target: { value: 'smc.test.local' },
    });
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'secret' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(tauri.stealthwatchSaveConfig).toHaveBeenCalledWith({
        host: 'smc.test.local',
        username: 'admin',
        password: 'secret',
        verifySsl: true,
      });
      expect(screen.getByText(/configuration saved/i)).toBeInTheDocument();
    });
  });
});
