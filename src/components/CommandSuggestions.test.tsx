import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { CommandSuggestions } from './CommandSuggestions';

describe('CommandSuggestions', () => {
  const mockSuggestions = [
    { command: 'ls -la', description: 'List all files', category: 'flags' },
    { command: 'ls -lh', description: 'Human-readable sizes', category: 'flags' },
    { command: 'lsof', description: 'List open files', category: 'commands' },
  ];

  it('should not render when no suggestions', () => {
    const { container } = render(
      <CommandSuggestions
        suggestions={[]}
        onSelect={vi.fn()}
        visible={true}
      />
    );

    expect(container.firstChild).toBeNull();
  });

  it('should render suggestions list', () => {
    render(
      <CommandSuggestions
        suggestions={mockSuggestions}
        onSelect={vi.fn()}
        visible={true}
      />
    );

    expect(screen.getByText('ls -la')).toBeInTheDocument();
    expect(screen.getByText('List all files')).toBeInTheDocument();
    expect(screen.getByText('ls -lh')).toBeInTheDocument();
    expect(screen.getByText('lsof')).toBeInTheDocument();
  });

  it('should call onSelect when suggestion clicked', () => {
    const onSelect = vi.fn();
    render(
      <CommandSuggestions
        suggestions={mockSuggestions}
        onSelect={onSelect}
        visible={true}
      />
    );

    fireEvent.click(screen.getByText('ls -la'));
    expect(onSelect).toHaveBeenCalledWith('ls -la');
  });

  it('should highlight selected index', () => {
    const { container } = render(
      <CommandSuggestions
        suggestions={mockSuggestions}
        onSelect={vi.fn()}
        visible={true}
        selectedIndex={1}
      />
    );

    const items = container.querySelectorAll('.suggestion-item');
    expect(items[1]).toHaveClass('selected');
  });

  it('should show loading state', () => {
    render(
      <CommandSuggestions
        suggestions={[]}
        onSelect={vi.fn()}
        visible={true}
        loading={true}
      />
    );

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});
