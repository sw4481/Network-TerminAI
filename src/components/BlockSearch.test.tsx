/**
 * BlockSearch component tests - Search UI with input and controls
 *
 * Tests search input, match counter, navigation buttons, and keyboard shortcuts.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BlockSearch } from './BlockSearch';

describe('BlockSearch', () => {
  it('renders input and controls', () => {
    const onSearchChange = vi.fn();
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const onClose = vi.fn();

    render(
      <BlockSearch
        searchQuery=""
        onSearchChange={onSearchChange}
        matchCount={0}
        currentMatch={0}
        onNext={onNext}
        onPrev={onPrev}
        onClose={onClose}
      />
    );

    expect(screen.getByPlaceholderText('Search in output...')).toBeInTheDocument();
    expect(screen.getByLabelText('Previous match')).toBeInTheDocument();
    expect(screen.getByLabelText('Next match')).toBeInTheDocument();
    expect(screen.getByLabelText('Close search')).toBeInTheDocument();
  });

  it('calls onSearchChange when input changes', () => {
    const onSearchChange = vi.fn();
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const onClose = vi.fn();

    render(
      <BlockSearch
        searchQuery=""
        onSearchChange={onSearchChange}
        matchCount={0}
        currentMatch={0}
        onNext={onNext}
        onPrev={onPrev}
        onClose={onClose}
      />
    );

    const input = screen.getByPlaceholderText('Search in output...');
    fireEvent.change(input, { target: { value: 'error' } });

    expect(onSearchChange).toHaveBeenCalledWith('error');
  });

  it('calls onNext/onPrev when buttons clicked', () => {
    const onSearchChange = vi.fn();
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const onClose = vi.fn();

    render(
      <BlockSearch
        searchQuery="test"
        onSearchChange={onSearchChange}
        matchCount={3}
        currentMatch={0}
        onNext={onNext}
        onPrev={onPrev}
        onClose={onClose}
      />
    );

    const nextBtn = screen.getByLabelText('Next match');
    const prevBtn = screen.getByLabelText('Previous match');

    fireEvent.click(nextBtn);
    expect(onNext).toHaveBeenCalledOnce();

    fireEvent.click(prevBtn);
    expect(onPrev).toHaveBeenCalledOnce();
  });

  it('shows "No matches" when matchCount is 0', () => {
    const onSearchChange = vi.fn();
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const onClose = vi.fn();

    render(
      <BlockSearch
        searchQuery="notfound"
        onSearchChange={onSearchChange}
        matchCount={0}
        currentMatch={0}
        onNext={onNext}
        onPrev={onPrev}
        onClose={onClose}
      />
    );

    expect(screen.getByText('No matches')).toBeInTheDocument();
  });

  it('handles keyboard shortcuts (Enter, Shift+Enter, Esc)', () => {
    const onSearchChange = vi.fn();
    const onNext = vi.fn();
    const onPrev = vi.fn();
    const onClose = vi.fn();

    render(
      <BlockSearch
        searchQuery="test"
        onSearchChange={onSearchChange}
        matchCount={3}
        currentMatch={0}
        onNext={onNext}
        onPrev={onPrev}
        onClose={onClose}
      />
    );

    const input = screen.getByPlaceholderText('Search in output...');

    // Enter key calls onNext
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onNext).toHaveBeenCalledOnce();

    // Shift+Enter calls onPrev
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(onPrev).toHaveBeenCalledOnce();

    // Escape calls onClose
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('supports a terminal-specific label and placeholder without changing defaults', () => {
    const props = {
      searchQuery: '',
      onSearchChange: vi.fn(),
      matchCount: 0,
      currentMatch: 0,
      onNext: vi.fn(),
      onPrev: vi.fn(),
      onClose: vi.fn(),
    };
    const { rerender } = render(
      <BlockSearch
        {...props}
        inputLabel="Search terminal scrollback"
        placeholder="Search terminal scrollback…"
      />,
    );
    expect(screen.getByLabelText('Search terminal scrollback')).toHaveAttribute(
      'placeholder',
      'Search terminal scrollback…',
    );

    rerender(<BlockSearch {...props} />);
    expect(screen.getByLabelText('Search in output')).toHaveAttribute(
      'placeholder',
      'Search in output...',
    );
  });
});
