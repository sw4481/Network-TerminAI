-- Workspace identity/title and chat ownership remain in tabs.
CREATE TABLE copilot_canvas_runs (
    id TEXT PRIMARY KEY,
    tab_id TEXT NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('collecting', 'awaiting_approval', 'completed', 'failed', 'cancelled', 'interrupted')),
    started_at TEXT NOT NULL,
    ended_at TEXT,
    scope_json TEXT NOT NULL DEFAULT 'null',
    coverage_json TEXT NOT NULL DEFAULT 'null',
    event_hashes_json TEXT NOT NULL DEFAULT '{}',
    warnings_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX copilot_canvas_runs_tab ON copilot_canvas_runs(tab_id);
CREATE TABLE copilot_canvas_evidence (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES copilot_canvas_runs(id) ON DELETE CASCADE,
    snapshot_json TEXT NOT NULL
);
CREATE INDEX copilot_canvas_evidence_run ON copilot_canvas_evidence(run_id);
CREATE TABLE copilot_canvas_cards (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES copilot_canvas_runs(id) ON DELETE CASCADE,
    insertion_order INTEGER NOT NULL,
    card_json TEXT NOT NULL
);
CREATE INDEX copilot_canvas_cards_run ON copilot_canvas_cards(run_id);
