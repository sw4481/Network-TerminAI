-- V0023__command_patterns.sql
-- Command templates/patterns for quick command insertion

CREATE TABLE IF NOT EXISTS command_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  template TEXT NOT NULL,
  description TEXT NOT NULL,
  parameters TEXT, -- JSON array of parameter names
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_command_patterns_category ON command_patterns(category);
