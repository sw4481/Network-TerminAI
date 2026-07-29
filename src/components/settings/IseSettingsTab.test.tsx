import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import IseSettingsTab from './IseSettingsTab';
import * as tauri from '../../lib/tauri';

vi.mock('../../lib/tauri', () => ({
  iseGetConfig: vi.fn(),
  iseSaveConfig: vi.fn(),
  iseTestConnection: vi.fn(),
}));

describe('IseSettingsTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders form fields and buttons', () => {
    vi.mocked(tauri.iseGetConfig).mockResolvedValue(null);

    render(<IseSettingsTab />);

    expect(screen.getByLabelText(/host/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/username/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/verify ssl/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument();
  });

  it('loads config from database on mount', async () => {
    const mockConfig = {
      host: 'ise.example.com',
      username: 'admin',
      password: 'secret',
      verifySsl: false,
    };
    vi.mocked(tauri.iseGetConfig).mockResolvedValue(mockConfig);

    render(<IseSettingsTab />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('ise.example.com')).toBeInTheDocument();
      expect(screen.getByDisplayValue('admin')).toBeInTheDocument();
    });
  });

  it('validates empty host before testing', async () => {
    vi.mocked(tauri.iseGetConfig).mockResolvedValue(null);

    render(<IseSettingsTab />);

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/enter a host before testing/i)).toBeInTheDocument();
    });

    expect(tauri.iseTestConnection).not.toHaveBeenCalled();
  });

  it('calls iseTestConnection and displays success', async () => {
    vi.mocked(tauri.iseGetConfig).mockResolvedValue(null);
    vi.mocked(tauri.iseTestConnection).mockResolvedValue({
      ok: true,
      message: 'Connected to ISE at ise.test.local (ERS reachable).',
    });

    render(<IseSettingsTab />);

    fireEvent.change(screen.getByLabelText(/host/i), {
      target: { value: 'ise.test.local' },
    });

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/ERS reachable/)).toBeInTheDocument();
    });
  });

  it('displays error message on test failure', async () => {
    vi.mocked(tauri.iseGetConfig).mockResolvedValue(null);
    vi.mocked(tauri.iseTestConnection).mockResolvedValue({
      ok: false,
      message: 'Authentication failed. Check credentials.',
    });

    render(<IseSettingsTab />);

    fireEvent.change(screen.getByLabelText(/host/i), {
      target: { value: 'ise.test.local' },
    });

    fireEvent.click(screen.getByRole('button', { name: /test connection/i }));

    await waitFor(() => {
      expect(screen.getByText(/Authentication failed/)).toBeInTheDocument();
    });
  });

  it('saves config to database and shows success', async () => {
    vi.mocked(tauri.iseGetConfig).mockResolvedValue(null);
    vi.mocked(tauri.iseSaveConfig).mockResolvedValue(undefined);

    render(<IseSettingsTab />);

    fireEvent.change(screen.getByLabelText(/host/i), {
      target: { value: 'ise.test.local' },
    });
    fireEvent.change(screen.getByLabelText(/username/i), {
      target: { value: 'admin' },
    });
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: 'secret' },
    });

    fireEvent.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() => {
      expect(tauri.iseSaveConfig).toHaveBeenCalledWith({
        host: 'ise.test.local',
        username: 'admin',
        password: 'secret',
        verifySsl: false,
      });
      expect(screen.getByText(/configuration saved/i)).toBeInTheDocument();
    });
  });
});
