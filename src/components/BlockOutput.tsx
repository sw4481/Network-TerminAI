import { memo, useState, useMemo, useEffect, useRef } from 'react';
import './BlockOutput.css';

interface BlockOutputProps {
  output: string;
  outputLineCount: number;
  collapsed: boolean;
  active: boolean;
  autoCollapse?: boolean; // default true
  children?: React.ReactNode; // For active xterm terminal
  searchQuery?: string;
  searchMatches?: number[];
  currentMatchIndex?: number;
}

const AUTO_COLLAPSE_THRESHOLD = 50;
const TRUNCATE_THRESHOLD = 500;
const TRUNCATE_SHOW_LINES = 100;

/**
 * Highlights search matches in text with special emphasis on current match.
 */
function highlightMatches(
  text: string,
  searchQuery: string,
  matches: number[],
  currentMatchIndex: number,
  searchQueryLength: number
): React.ReactNode {
  if (!searchQuery || matches.length === 0) {
    return text;
  }

  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  matches.forEach((matchPos, idx) => {
    // Add text before match
    if (matchPos > lastIndex) {
      parts.push(text.substring(lastIndex, matchPos));
    }

    // Add highlighted match
    const matchText = text.substring(matchPos, matchPos + searchQueryLength);
    const isCurrent = idx === currentMatchIndex;
    parts.push(
      <span
        key={`match-${matchPos}`}
        className={`search-match ${isCurrent ? 'current' : ''}`}
      >
        {matchText}
      </span>
    );

    lastIndex = matchPos + searchQueryLength;
  });

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(text.substring(lastIndex));
  }

  return parts;
}

export const BlockOutput = memo(function BlockOutput({
  output,
  outputLineCount,
  collapsed,
  active,
  autoCollapse = true,
  children,
  searchQuery,
  searchMatches,
  currentMatchIndex,
}: BlockOutputProps) {
  const [showFullOutput, setShowFullOutput] = useState(false);

  // CRITICAL FIX: Track if user has explicitly expanded to prevent re-collapse loop
  // We track the previous collapsed value to detect transitions
  const prevCollapsedRef = useRef(collapsed);
  const [userExpanded, setUserExpanded] = useState(false);

  useEffect(() => {
    // Detect when user expands (collapsed transitions from true to false)
    if (prevCollapsedRef.current === true && collapsed === false) {
      setUserExpanded(true);
    }
    // Reset when collapsed again
    if (collapsed === true) {
      setUserExpanded(false);
    }
    prevCollapsedRef.current = collapsed;
  }, [collapsed]);

  // Auto-collapse only if user hasn't explicitly expanded
  const shouldAutoCollapse = autoCollapse && outputLineCount > AUTO_COLLAPSE_THRESHOLD && !userExpanded;
  const shouldTruncate = outputLineCount > TRUNCATE_THRESHOLD && !showFullOutput;

  // Truncate very large outputs with performance optimization
  // MUST be before any early returns to comply with Rules of Hooks
  const truncatedContent = useMemo(() => {
    if (!shouldTruncate) return null;

    const lines = output.split('\n');
    const hiddenCount = lines.length - (TRUNCATE_SHOW_LINES * 2);

    // Edge case: Don't truncate if hiding less than 10 lines
    if (hiddenCount < 10) return null;

    const firstLines = lines.slice(0, TRUNCATE_SHOW_LINES).join('\n');
    const lastLines = lines.slice(-TRUNCATE_SHOW_LINES).join('\n');

    return {
      firstLines,
      lastLines,
      hiddenCount,
    };
  }, [output, shouldTruncate]);

  // Apply search highlighting to displayed content
  const displayContent = useMemo(() => {
    const contentToDisplay = shouldTruncate && truncatedContent
      ? `${truncatedContent.firstLines}\n${truncatedContent.lastLines}`
      : output;

    if (searchQuery && searchMatches && searchMatches.length > 0) {
      return highlightMatches(
        contentToDisplay,
        searchQuery,
        searchMatches,
        currentMatchIndex ?? 0,
        searchQuery.length
      );
    }

    return contentToDisplay;
  }, [output, shouldTruncate, truncatedContent, searchQuery, searchMatches, currentMatchIndex]);

  // Show collapsed view if manually collapsed OR should auto-collapse
  if (collapsed || shouldAutoCollapse) {
    return (
      <div className="block-output collapsed">
        <span className="collapse-hint">
          {outputLineCount} lines (click to expand)
        </span>
      </div>
    );
  }

  if (active && children != null) {
    // Live block: render the live xterm passed as children. Guard on
    // `children` because a *focused* history block (block-list path) is also
    // `active` but has no live xterm — without this guard it would render an
    // empty div and blank out its own output.
    return (
      <div className="block-output active">
        {children}
      </div>
    );
  }

  if (shouldTruncate && truncatedContent) {
    // Calculate section boundaries for match filtering
    const firstSectionEnd = truncatedContent.firstLines.length;
    const lastSectionStart = output.length - truncatedContent.lastLines.length;

    // Filter matches by section
    const firstSectionMatches = searchMatches?.filter(pos => pos < firstSectionEnd) ?? [];
    const lastSectionMatches = searchMatches?.filter(pos => pos >= lastSectionStart)
      .map(pos => pos - lastSectionStart) ?? [];

    // Determine which section contains the current match and convert to section-local index
    let firstCurrentIdx = -1;
    let lastCurrentIdx = -1;

    if (searchMatches && currentMatchIndex !== undefined) {
      const globalCurrentMatchPos = searchMatches[currentMatchIndex];

      if (globalCurrentMatchPos !== undefined) {
        if (globalCurrentMatchPos < firstSectionEnd) {
          // Current match is in first section
          firstCurrentIdx = firstSectionMatches.findIndex(pos => pos === globalCurrentMatchPos);
        } else if (globalCurrentMatchPos >= lastSectionStart) {
          // Current match is in last section
          const remappedPos = globalCurrentMatchPos - lastSectionStart;
          lastCurrentIdx = lastSectionMatches.findIndex(pos => pos === remappedPos);
        }
        // else: current match is in hidden middle section - no highlight
      }
    }

    const firstContent = searchQuery && firstSectionMatches.length > 0
      ? highlightMatches(
          truncatedContent.firstLines,
          searchQuery,
          firstSectionMatches,
          firstCurrentIdx,
          searchQuery.length
        )
      : truncatedContent.firstLines;

    const lastContent = searchQuery && lastSectionMatches.length > 0
      ? highlightMatches(
          truncatedContent.lastLines,
          searchQuery,
          lastSectionMatches,
          lastCurrentIdx,
          searchQuery.length
        )
      : truncatedContent.lastLines;

    return (
      <div className="block-output truncated">
        <pre className="output-text">{firstContent}</pre>
        <div className="truncate-indicator">
          <button
            className="show-more-btn"
            onClick={() => setShowFullOutput(true)}
            aria-label={`Show all ${outputLineCount} lines of output`}
            aria-expanded="false"
          >
            ⋯ {truncatedContent.hiddenCount} lines hidden (click to show all)
          </button>
          <span className="truncate-hint">
            Showing first {TRUNCATE_SHOW_LINES} and last {TRUNCATE_SHOW_LINES} lines
          </span>
        </div>
        <pre className="output-text">{lastContent}</pre>
      </div>
    );
  }

  // Completed block: render as text
  return (
    <div className="block-output">
      <pre className="output-text">{displayContent}</pre>
    </div>
  );
});
