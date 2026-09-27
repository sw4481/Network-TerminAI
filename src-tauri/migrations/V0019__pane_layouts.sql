CREATE TABLE IF NOT EXISTS pane_layouts (
  id TEXT PRIMARY KEY,
  tab_id TEXT NOT NULL,
  layout_json TEXT NOT NULL, -- JSON serialized layout tree
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (tab_id) REFERENCES tabs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_pane_layouts_tab ON pane_layouts(tab_id);

-- Each tab has exactly one active layout
CREATE UNIQUE INDEX IF NOT EXISTS idx_pane_layouts_unique_tab ON pane_layouts(tab_id);
