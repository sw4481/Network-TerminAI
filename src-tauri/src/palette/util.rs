//! Shared helpers for the palette aggregator.

/// Wrap a free-form query in FTS5-safe double quotes so embedded operators
/// (`*`, `:`, `-`) are treated as literal text. Mirrors
/// [`crate::search::escape_fts5_query`] but is exposed via `palette::util` so
/// every source uses the same form without re-importing the private symbol.
pub fn escape_fts5_query(query: &str) -> String {
    format!("\"{}\"", query.replace('"', "\"\""))
}
