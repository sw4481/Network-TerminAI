import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BlockToolbar } from './BlockToolbar';

describe('BlockToolbar', () => {
  it('should render all 6 action buttons with correct titles', () => {
    render(
      <BlockToolbar
        onRerun={vi.fn()}
        onBookmark={vi.fn()}
        onCopy={vi.fn()}
        onExplain={vi.fn()}
        onSearch={vi.fn()}
        onExport={vi.fn()}
        bookmarked={false}
        visible={true}
      />
    );

    expect(screen.getByTitle('Rerun command')).toBeInTheDocument();
    expect(screen.getByTitle('Bookmark')).toBeInTheDocument();
    expect(screen.getByTitle('Copy output')).toBeInTheDocument();
    expect(screen.getByTitle('Explain command')).toBeInTheDocument();
    expect(screen.getByTitle('Search in output')).toBeInTheDocument();
    expect(screen.getByTitle('Export block')).toBeInTheDocument();
  });

  it('should have "hidden" class when visible=false', () => {
    const { container } = render(
      <BlockToolbar
        onRerun={vi.fn()}
        onBookmark={vi.fn()}
        onCopy={vi.fn()}
        onExplain={vi.fn()}
        onSearch={vi.fn()}
        onExport={vi.fn()}
        bookmarked={false}
        visible={false}
      />
    );

    const toolbar = container.querySelector('.block-toolbar');
    expect(toolbar).toHaveClass('hidden');
  });

  it('should not have "hidden" class when visible=true', () => {
    const { container } = render(
      <BlockToolbar
        onRerun={vi.fn()}
        onBookmark={vi.fn()}
        onCopy={vi.fn()}
        onExplain={vi.fn()}
        onSearch={vi.fn()}
        onExport={vi.fn()}
        bookmarked={false}
        visible={true}
      />
    );

    const toolbar = container.querySelector('.block-toolbar');
    expect(toolbar).not.toHaveClass('hidden');
  });

  it('should call button click handlers when clicked', () => {
    const handlers = {
      onRerun: vi.fn(),
      onBookmark: vi.fn(),
      onCopy: vi.fn(),
      onExplain: vi.fn(),
      onSearch: vi.fn(),
      onExport: vi.fn(),
    };

    render(
      <BlockToolbar
        {...handlers}
        bookmarked={false}
        visible={true}
      />
    );

    fireEvent.click(screen.getByTitle('Rerun command'));
    expect(handlers.onRerun).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTitle('Bookmark'));
    expect(handlers.onBookmark).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTitle('Copy output'));
    expect(handlers.onCopy).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTitle('Explain command'));
    expect(handlers.onExplain).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTitle('Search in output'));
    expect(handlers.onSearch).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByTitle('Export block'));
    expect(handlers.onExport).toHaveBeenCalledOnce();
  });

  it('should show "Remove bookmark" title when bookmarked=true', () => {
    render(
      <BlockToolbar
        onRerun={vi.fn()}
        onBookmark={vi.fn()}
        onCopy={vi.fn()}
        onExplain={vi.fn()}
        onSearch={vi.fn()}
        onExport={vi.fn()}
        bookmarked={true}
        visible={true}
      />
    );

    expect(screen.getByTitle('Remove bookmark')).toBeInTheDocument();
  });

  it('should apply "bookmarked" class to bookmark button when bookmarked=true', () => {
    render(
      <BlockToolbar
        onRerun={vi.fn()}
        onBookmark={vi.fn()}
        onCopy={vi.fn()}
        onExplain={vi.fn()}
        onSearch={vi.fn()}
        onExport={vi.fn()}
        bookmarked={true}
        visible={true}
      />
    );

    const bookmarkBtn = screen.getByTitle('Remove bookmark');
    expect(bookmarkBtn).toHaveClass('bookmarked');
  });
});
