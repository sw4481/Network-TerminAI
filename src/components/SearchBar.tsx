import { useEffect, useState, useRef } from "react";
import { useSearch } from "../state/searchStore";
import { useDebounce } from "../hooks/useDebounce";
import { searchAll } from "../lib/tauri";
import { SearchResults } from "./SearchResults";

export function SearchBar() {
  const {
    isOpen,
    query,
    filter,
    setQuery,
    setFilter,
    setResults,
    clearSearch,
  } = useSearch();

  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Use the new useDebounce hook for cleaner code
  const debouncedQuery = useDebounce(query, 300);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  // Perform search when debounced query changes
  useEffect(() => {
    const performSearch = async () => {
      if (!debouncedQuery.trim()) {
        setResults({ commands: [], ai_messages: [], skills: [] });
        return;
      }

      setLoading(true);
      try {
        const results = await searchAll(debouncedQuery, 50);
        setResults(results);
      } catch (error) {
        console.error("Search error:", error);
        setResults({ commands: [], ai_messages: [], skills: [] });
      } finally {
        setLoading(false);
      }
    };

    performSearch();
  }, [debouncedQuery, setResults]);

  const handleClose = () => {
    clearSearch();
  };

  if (!isOpen) return null;

  return (
    <div className="search-overlay" onClick={handleClose}>
      <div className="search-container" onClick={(e) => e.stopPropagation()}>
        <div className="search-header">
          <input
            ref={inputRef}
            type="text"
            className="search-input"
            placeholder="Search commands, AI chat, skills..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                handleClose();
              }
            }}
          />
          <div className="search-filters">
            <button
              className={filter === "all" ? "filter-active" : ""}
              onClick={() => setFilter("all")}
            >
              All
            </button>
            <button
              className={filter === "commands" ? "filter-active" : ""}
              onClick={() => setFilter("commands")}
            >
              Commands
            </button>
            <button
              className={filter === "ai" ? "filter-active" : ""}
              onClick={() => setFilter("ai")}
            >
              AI
            </button>
            <button
              className={filter === "skills" ? "filter-active" : ""}
              onClick={() => setFilter("skills")}
            >
              Skills
            </button>
          </div>
          <button className="search-close" onClick={handleClose}>
            ✕
          </button>
        </div>
        <SearchResults loading={loading} />
      </div>
    </div>
  );
}
