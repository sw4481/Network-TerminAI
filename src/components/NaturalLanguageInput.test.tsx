import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NaturalLanguageInput } from './NaturalLanguageInput';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('NaturalLanguageInput', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render input with placeholder', () => {
    render(
      <NaturalLanguageInput
        onCommandGenerated={vi.fn()}
        onClose={vi.fn()}
        cwd="/test/dir"
        tabId="test-tab-1"
        paneId="test-pane-1"
      />
    );

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(screen.getByLabelText(/describe what you want to do/i)).toBeInTheDocument();
  });

  it('should call AI to convert natural language to command', async () => {
    const { invoke: mockInvoke } = await import('@tauri-apps/api/core');
    vi.mocked(mockInvoke).mockResolvedValue({
      command: 'find . -name "*.txt"',
      explanation: 'Finds all text files in current directory',
    });

    const onCommandGenerated = vi.fn();
    render(
      <NaturalLanguageInput
        onCommandGenerated={onCommandGenerated}
        onClose={vi.fn()}
        cwd="/test/dir"
        tabId="test-tab-1"
        paneId="test-pane-1"
      />
    );

    const input = screen.getByRole('textbox');
    fireEvent.change(input, { target: { value: 'find all text files' } });
    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => {
      expect(mockInvoke).toHaveBeenCalledWith('ai_natural_to_command', {
        naturalLanguage: 'find all text files',
        cwd: '/test/dir',
        tabId: 'test-tab-1',
        paneId: 'test-pane-1',
      });
    });

    await waitFor(() => {
      expect(screen.getByText('find . -name "*.txt"')).toBeInTheDocument();
    });
  });

  it('should show loading state while generating', async () => {
    const { invoke: mockInvoke } = await import('@tauri-apps/api/core');
    vi.mocked(mockInvoke).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ command: 'ls', explanation: 'List files' }), 100))
    );

    render(
      <NaturalLanguageInput
        onCommandGenerated={vi.fn()}
        onClose={vi.fn()}
        cwd="/test/dir"
        tabId="test-tab-1"
      />
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'list files' },
    });
    fireEvent.click(screen.getByText('Generate'));

    expect(await screen.findByText(/generating/i)).toBeInTheDocument();
  });

  it('should call onClose when cancel clicked', () => {
    const onClose = vi.fn();
    render(
      <NaturalLanguageInput
        onCommandGenerated={vi.fn()}
        onClose={onClose}
        cwd="/test/dir"
        tabId="test-tab-1"
      />
    );

    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('should show Use Command button after generation', async () => {
    const { invoke: mockInvoke } = await import('@tauri-apps/api/core');
    vi.mocked(mockInvoke).mockResolvedValue({
      command: 'ls -la',
      explanation: 'List all files with details',
    });

    const onCommandGenerated = vi.fn();
    render(
      <NaturalLanguageInput
        onCommandGenerated={onCommandGenerated}
        onClose={vi.fn()}
        cwd="/test/dir"
        tabId="test-tab-1"
      />
    );

    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'list all files' },
    });
    fireEvent.click(screen.getByText('Generate'));

    await waitFor(() => {
      expect(screen.getByText('Use Command')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Use Command'));
    expect(onCommandGenerated).toHaveBeenCalledWith('ls -la');
  });

  it('should handle keyboard shortcuts', () => {
    const onClose = vi.fn();
    render(
      <NaturalLanguageInput
        onCommandGenerated={vi.fn()}
        onClose={onClose}
        cwd="/test/dir"
        tabId="test-tab-1"
      />
    );

    const textarea = screen.getByRole('textbox');
    fireEvent.keyDown(textarea, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
  });
});
