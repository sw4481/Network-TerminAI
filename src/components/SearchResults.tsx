import { memo, useMemo } from "react";
import { useSearch } from "../state/searchStore";
import { useTabs } from "../state/tabsStore";

type Props = {
  loading: boolean;
};

/**
 * SearchResults component with performance optimizations.
 * Uses React.memo to prevent re-renders when search results haven't changed.
 * Uses useMemo to optimize expensive computations for large result sets.
 */
export const SearchResults = memo(function SearchResults({ loading }: Props) {
  const { results, filter, selectedIndex, setSelectedIndex, clearSearch } =
    useSearch();
  const { setActive, tabs } = useTabs();

  if (loading) {
    return (
      <div className="search-results">
        <div className="search-loading">Searching...</div>
      </div>
    );
  }

  if (
    !results ||
    (results.commands.length === 0 &&
      results.ai_messages.length === 0 &&
      results.skills.length === 0)
  ) {
    return (
      <div className="search-results">
        <div className="search-empty">No results found</div>
      </div>
    );
  }

  // Memoize filter flags to avoid recalculation on every render
  const { showCommands, showAI, showSkills } = useMemo(
    () => ({
      showCommands: filter === "all" || filter === "commands",
      showAI: filter === "all" || filter === "ai",
      showSkills: filter === "all" || filter === "skills",
    }),
    [filter]
  );

  // Memoize tab lookup map for O(1) access instead of O(n) find operations
  const tabMap = useMemo(() => {
    const map = new Map();
    tabs.forEach((tab) => map.set(tab.id, tab));
    return map;
  }, [tabs]);

  const handleCommandClick = (tabId: string) => {
    setActive(tabId);
    clearSearch();
  };

  const handleAIClick = (tabId: string | null) => {
    if (tabId) {
      setActive(tabId);
    }
    clearSearch();
  };

  const handleSkillClick = () => {
    // TODO: Open Skills Settings
    clearSearch();
  };

  return (
    <div className="search-results">
      {showCommands && results.commands.length > 0 && (
        <div className="result-group">
          <h4 className="result-group-title">
            Commands ({results.commands.length})
          </h4>
          {results.commands.map((result, idx) => {
            const tab = tabMap.get(result.tab_id);
            return (
              <div
                key={result.id}
                className={`result-item ${
                  idx === selectedIndex ? "result-selected" : ""
                }`}
                onClick={() => handleCommandClick(result.tab_id)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <div className="result-icon">🔧</div>
                <div className="result-content">
                  <div className="result-header">
                    <code className="result-cmd">{result.cmd}</code>
                    {tab && (
                      <span className="result-location">{tab.title}</span>
                    )}
                  </div>
                  <div className="result-snippet">{result.output_snippet}</div>
                  <div className="result-meta">
                    {new Date(result.started_at * 1000).toLocaleString()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showAI && results.ai_messages.length > 0 && (
        <div className="result-group">
          <h4 className="result-group-title">
            AI Messages ({results.ai_messages.length})
          </h4>
          {results.ai_messages.map((result, idx) => {
            const tab = result.tab_id ? tabMap.get(result.tab_id) : null;
            const globalIndex = results.commands.length + idx;
            return (
              <div
                key={result.id}
                className={`result-item ${
                  globalIndex === selectedIndex ? "result-selected" : ""
                }`}
                onClick={() => handleAIClick(result.tab_id)}
                onMouseEnter={() => setSelectedIndex(globalIndex)}
              >
                <div className="result-icon">💬</div>
                <div className="result-content">
                  <div className="result-header">
                    <span className="result-role">
                      {result.role === "user" ? "You" : "Assistant"}
                    </span>
                    {tab && (
                      <span className="result-location">{tab.title}</span>
                    )}
                  </div>
                  <div className="result-snippet">{result.content_snippet}</div>
                  <div className="result-meta">
                    {new Date(result.created_at * 1000).toLocaleString()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {showSkills && results.skills.length > 0 && (
        <div className="result-group">
          <h4 className="result-group-title">
            Skills ({results.skills.length})
          </h4>
          {results.skills.map((result, idx) => {
            const globalIndex =
              results.commands.length + results.ai_messages.length + idx;
            return (
              <div
                key={result.id}
                className={`result-item ${
                  globalIndex === selectedIndex ? "result-selected" : ""
                }`}
                onClick={handleSkillClick}
                onMouseEnter={() => setSelectedIndex(globalIndex)}
              >
                <div className="result-icon">📖</div>
                <div className="result-content">
                  <div className="result-header">
                    <span className="result-skill-name">{result.name}</span>
                  </div>
                  <div className="result-description">{result.description}</div>
                  <div className="result-snippet">{result.when_to_use}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
});
