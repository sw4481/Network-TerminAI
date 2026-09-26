import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { BlockOutput } from './BlockOutput';

describe('BlockOutput active vs. live-xterm rendering', () => {
  it('renders the live xterm children when active AND children are provided', () => {
    const { getByTestId, queryByText } = render(
      <BlockOutput output={'stale output'} outputLineCount={1} collapsed={false} active={true}>
        <div data-testid="live-xterm">xterm</div>
      </BlockOutput>,
    );
    expect(getByTestId('live-xterm')).toBeInTheDocument();
    // Static output must NOT render while the live terminal is shown.
    expect(queryByText('stale output')).not.toBeInTheDocument();
  });

  it('falls back to static output when active but NO children (history block, not live)', () => {
    // Regression: focusing a completed block in the block list marks it
    // active, but it has no live xterm child — it must still show its output,
    // not blank out.
    const { container } = render(
      <BlockOutput output={'Session count = 1'} outputLineCount={1} collapsed={false} active={true} />,
    );
    expect(container.querySelector('.output-text')?.textContent).toBe('Session count = 1');
  });
});

describe('BlockOutput auto-collapse and truncation', () => {
  it('renders small output (≤50 lines) fully without auto-collapse', () => {
    const smallOutput = Array(30).fill('line').join('\n');

    const { container } = render(
      <BlockOutput
        output={smallOutput}
        outputLineCount={30}
        collapsed={false}
        active={false}
      />
    );

    // Should render full output
    expect(container.querySelector('.output-text')).toBeInTheDocument();
    expect(container.querySelector('.output-text')?.textContent).toBe(smallOutput);

    // Should NOT show collapse hint
    expect(screen.queryByText(/lines \(click to expand\)/)).not.toBeInTheDocument();
  });

  it('auto-collapses large output (>50 lines) with hint', () => {
    const largeOutput = Array(60).fill('line').join('\n');

    render(
      <BlockOutput
        output={largeOutput}
        outputLineCount={60}
        collapsed={false}
        active={false}
        autoCollapse={true}
      />
    );

    // Should show collapse hint instead of full output
    expect(screen.getByText(/60 lines \(click to expand\)/)).toBeInTheDocument();
  });

  it('truncates very large output (>500 lines) showing first/last 100 lines', () => {
    const lines = Array(1000).fill(0).map((_, i) => `line-${i}`);
    const largeOutput = lines.join('\n');

    const { container } = render(
      <BlockOutput
        output={largeOutput}
        outputLineCount={1000}
        collapsed={false}
        active={false}
        autoCollapse={false} // Disable auto-collapse to test truncation
      />
    );

    const outputElements = container.querySelectorAll('.output-text');
    expect(outputElements.length).toBe(2); // Should have two pre elements

    const firstPart = outputElements[0].textContent || '';
    const lastPart = outputElements[1].textContent || '';

    // Should show first 100 lines
    expect(firstPart).toContain('line-0');
    expect(firstPart).toContain('line-99');

    // Should show last 100 lines
    expect(lastPart).toContain('line-900');
    expect(lastPart).toContain('line-999');

    // Should NOT show middle lines in either part
    expect(firstPart).not.toContain('line-500');
    expect(lastPart).not.toContain('line-500');

    // Should show truncation indicator
    expect(screen.getByText(/800 lines hidden/)).toBeInTheDocument();
    expect(screen.getByText(/Showing first 100 and last 100 lines/)).toBeInTheDocument();
  });

  it('expands truncated output when "Show all" button is clicked', () => {
    const lines = Array(600).fill(0).map((_, i) => `line-${i}`);
    const largeOutput = lines.join('\n');

    const { container } = render(
      <BlockOutput
        output={largeOutput}
        outputLineCount={600}
        collapsed={false}
        active={false}
        autoCollapse={false} // Disable auto-collapse to test truncation
      />
    );

    // Initially truncated - middle should not be visible
    let outputText = container.querySelector('.output-text')?.textContent || '';
    expect(outputText).not.toContain('line-300');

    // Click "Show all" button
    const showMoreBtn = screen.getByText(/400 lines hidden/);
    fireEvent.click(showMoreBtn);

    // Now all output should be visible
    outputText = container.querySelector('.output-text')?.textContent || '';
    expect(outputText).toContain('line-0');
    expect(outputText).toContain('line-300');
    expect(outputText).toContain('line-599');

    // Truncation indicator should be gone
    expect(screen.queryByText(/400 lines hidden/)).not.toBeInTheDocument();
  });

  it('respects manual collapse (collapsed prop) over auto-collapse', () => {
    const largeOutput = Array(60).fill('line').join('\n');

    render(
      <BlockOutput
        output={largeOutput}
        outputLineCount={60}
        collapsed={true}
        active={false}
        autoCollapse={false}
      />
    );

    // Should show collapse hint when manually collapsed
    expect(screen.getByText(/60 lines \(click to expand\)/)).toBeInTheDocument();
  });

  it('disables auto-collapse when autoCollapse prop is false', () => {
    const largeOutput = Array(60).fill('line').join('\n');

    const { container } = render(
      <BlockOutput
        output={largeOutput}
        outputLineCount={60}
        collapsed={false}
        active={false}
        autoCollapse={false}
      />
    );

    // Should render full output, no auto-collapse
    expect(container.querySelector('.output-text')).toBeInTheDocument();
    expect(screen.queryByText(/60 lines \(click to expand\)/)).not.toBeInTheDocument();
  });

  it('allows user to expand auto-collapsed output without re-collapsing', () => {
    const largeOutput = Array(60).fill('line').join('\n');

    const { rerender } = render(
      <BlockOutput
        output={largeOutput}
        outputLineCount={60}
        collapsed={true}
        active={false}
        autoCollapse={true}
      />
    );

    // Initially auto-collapsed
    expect(screen.getByText(/60 lines \(click to expand\)/)).toBeInTheDocument();

    // Simulate user clicking expand (store sets collapsed=false)
    rerender(
      <BlockOutput
        output={largeOutput}
        outputLineCount={60}
        collapsed={false}
        active={false}
        autoCollapse={true}
      />
    );

    // Should show output, NOT re-collapse
    const outputEl = screen.getByText(/line/);
    expect(outputEl).toBeInTheDocument();
    expect(outputEl.textContent).toContain('line'); // Should contain the actual output
    expect(screen.queryByText(/lines \(click to expand\)/)).not.toBeInTheDocument();
  });

  it('highlights correct match in truncated output sections', () => {
    const lines = Array.from({ length: 600 }, (_, i) =>
      i % 50 === 0 ? 'MATCH' : `line ${i}`
    );
    const output = lines.join('\n');

    // Calculate actual character positions
    // First 100 lines: ~786 chars, last 100 lines start at ~4363
    // Matches occur at: 0, 389 (in first section), then middle matches, then last section matches
    const allMatches = [];
    let idx = 0;
    while ((idx = output.indexOf('MATCH', idx)) !== -1) {
      allMatches.push(idx);
      idx += 5;
    }

    // Test: Current match is the SECOND match overall (index 1)
    // This should only highlight ONE match total, not TWO (one in each section)
    const { container } = render(
      <BlockOutput
        output={output}
        outputLineCount={600}
        collapsed={false}
        active={false}
        autoCollapse={false}
        searchQuery="MATCH"
        searchMatches={allMatches}
        currentMatchIndex={1}  // Second match (at position 389)
      />
    );

    const currentHighlights = container.querySelectorAll('.search-match.current');
    expect(currentHighlights.length).toBe(1);  // Only one current match, not multiple

    // Verify we have regular matches in both sections
    const allHighlights = container.querySelectorAll('.search-match');
    expect(allHighlights.length).toBeGreaterThan(2);  // Multiple matches across sections
  });
});
