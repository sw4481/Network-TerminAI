import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import TerminalSettingsTab from './TerminalSettingsTab';
import * as paneActivityLib from '../lib/paneActivity';

describe('TerminalSettingsTab', () => {
  it('loads and displays current preferences', async () => {
    vi.spyOn(paneActivityLib, 'getNotificationPreferences').mockResolvedValue({
      minDurationSecs: 30,
      notifyOnNonzeroExit: true,
      notifyOnAgentOutput: true,
      keywordTriggers: ['error', 'failed', 'timeout'],
      ignoreCommands: ['tail', 'watch', 'top', 'htop'],
      enableSound: false,
    });

    render(<TerminalSettingsTab />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Minimum duration/i)).toHaveValue(30);
    });
  });

  it('saves preferences on submit', async () => {
    const saveSpy = vi.spyOn(paneActivityLib, 'updateNotificationPreferences').mockResolvedValue();
    vi.spyOn(paneActivityLib, 'getNotificationPreferences').mockResolvedValue({
      minDurationSecs: 30,
      notifyOnNonzeroExit: true,
      notifyOnAgentOutput: true,
      keywordTriggers: ['error'],
      ignoreCommands: ['tail'],
      enableSound: false,
    });

    render(<TerminalSettingsTab />);

    await waitFor(() => screen.getByLabelText(/Minimum duration/i));

    const input = screen.getByLabelText(/Minimum duration/i);
    fireEvent.change(input, { target: { value: '60' } });

    const saveBtn = screen.getByText(/Save/i);
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledWith(
        expect.objectContaining({ minDurationSecs: 60 })
      );
    });
  });
});
