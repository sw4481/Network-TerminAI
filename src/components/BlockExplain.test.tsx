import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BlockExplain } from './BlockExplain';

describe('BlockExplain', () => {
  it('renders popover with explanation text', () => {
    const onClose = vi.fn();
    const explanation = 'This command lists all files in long format with hidden files visible.';

    render(
      <BlockExplain
        explanation={explanation}
        loading={false}
        onClose={onClose}
      />
    );

    expect(screen.getByText('Command Explanation')).toBeInTheDocument();
    expect(screen.getByText(explanation)).toBeInTheDocument();
  });

  it('shows loading state with spinner', () => {
    const onClose = vi.fn();

    render(
      <BlockExplain
        explanation={null}
        loading={true}
        onClose={onClose}
      />
    );

    expect(screen.getByText('Explaining command...')).toBeInTheDocument();
    expect(screen.getByText('⏳')).toBeInTheDocument();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    const explanation = 'Test explanation';

    render(
      <BlockExplain
        explanation={explanation}
        loading={false}
        onClose={onClose}
      />
    );

    const closeButton = screen.getByTitle('Close explanation');
    fireEvent.click(closeButton);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
