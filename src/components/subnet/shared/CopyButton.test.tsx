import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CopyButton } from './CopyButton';

describe('CopyButton', () => {
  beforeEach(() => {
    // Mock clipboard API
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(() => Promise.resolve()),
      },
    });
  });

  it('renders copy button', () => {
    render(<CopyButton text="192.168.1.0" />);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });

  it('copies text to clipboard on click', async () => {
    render(<CopyButton text="192.168.1.0" />);
    const button = screen.getByRole('button');
    fireEvent.click(button);

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('192.168.1.0');
  });

  it('shows checkmark after successful copy', async () => {
    render(<CopyButton text="test" />);
    const button = screen.getByRole('button');

    fireEvent.click(button);

    // Button should show checkmark (✓) briefly
    await waitFor(() => {
      expect(button.textContent).toContain('✓');
    });
  });
});
